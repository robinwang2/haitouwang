import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  ApplicationIdempotencyRecord,
  ApplicationReceiptRecord,
  ApplicationsStore,
} from './applications-store.interface';
import type {
  Application,
  ApplicationAuditEvent,
  ApplicationStatus,
  ManualApplicationTask,
  ManualReason,
  ResourceRef,
  SubmissionEvidence,
  TimelineEntry,
} from './applications.types';

type Executor = Pool | PoolClient;

interface ApplicationRow extends QueryResultRow {
  id: string;
  user_id: string;
  job_id: string;
  goal_id: string;
  material_ids: string[];
  status: ApplicationStatus;
  submission_idempotency_key: string;
  evidence: SubmissionEvidence[];
  timeline: TimelineEntry[];
  deadline_at: Date | null;
  manual_reason: ManualReason | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface ManualTaskRow extends QueryResultRow {
  id: string;
  user_id: string;
  application_id: string;
  application_version: number;
  status: ManualApplicationTask['status'];
  manual_reason: ManualReason;
  package: ManualApplicationTask['package'];
  created_at: Date;
  updated_at: Date;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response: unknown;
  audit_event_id: string;
}

interface ReceiptRow extends QueryResultRow {
  receipt_id: string;
  request_hash: string;
  response: ApplicationReceiptRecord['response'];
}

interface AuditRow extends QueryResultRow {
  event_id: string;
  actor: ApplicationAuditEvent['actor'];
  action: string;
  resource: ResourceRef;
  outcome: ApplicationAuditEvent['outcome'];
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus | null;
  reason_code: string | null;
  replayed_from_event_id: string | null;
  occurred_at: Date;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function mapApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    user_id: row.user_id,
    job_id: row.job_id,
    goal_id: row.goal_id,
    material_ids: row.material_ids,
    status: row.status,
    submission_idempotency_key: row.submission_idempotency_key,
    evidence: row.evidence,
    timeline: row.timeline,
    ...(row.deadline_at ? { deadline_at: toIso(row.deadline_at) } : {}),
    ...(row.manual_reason ? { manual_reason: row.manual_reason } : {}),
    version: row.version,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function mapManualTask(row: ManualTaskRow): ManualApplicationTask {
  return {
    id: row.id,
    user_id: row.user_id,
    type: 'manual_application',
    status: row.status,
    resource: { type: 'application', id: row.application_id, version: row.application_version },
    attempt: 0,
    max_attempts: 1,
    manual_reason: row.manual_reason,
    package: row.package,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function mapAudit(row: AuditRow): ApplicationAuditEvent {
  return {
    event_id: row.event_id,
    occurred_at: toIso(row.occurred_at),
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    outcome: row.outcome,
    ...(row.from_status !== null ? { from_status: row.from_status } : {}),
    ...(row.to_status !== null ? { to_status: row.to_status } : {}),
    ...(row.reason_code !== null ? { reason_code: row.reason_code } : {}),
    ...(row.replayed_from_event_id !== null
      ? { replayed_from_event_id: row.replayed_from_event_id }
      : {}),
  };
}

/**
 * Postgres-backed implementation of ApplicationsStore. Every statement scopes its WHERE
 * clause by user_id. The submission-idempotency invariant (one application per
 * (user_id, submission_idempotency_key)) and the agent-receipt invariant (one timeline
 * record per (user_id, receipt_id)) are both enforced by SQL UNIQUE/PRIMARY KEY
 * constraints, not application logic - see infra/db/migrations/applications.
 */
export class PostgresApplicationsStore implements ApplicationsStore {
  constructor(
    readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  async withTransaction<T>(operation: (store: ApplicationsStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresApplicationsStore(this.pool, client);
      const result = await operation(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getApplication(userId: string, applicationId: string): Promise<Application | undefined> {
    const { rows } = await this.executor.query<ApplicationRow>(
      'SELECT * FROM applications_applications WHERE id = $1 AND user_id = $2',
      [applicationId, userId],
    );
    return rows[0] ? mapApplication(rows[0]) : undefined;
  }

  async saveApplication(userId: string, application: Application): Promise<void> {
    if (application.user_id !== userId) {
      throw new Error('Applications store tenant mismatch.');
    }
    await this.executor.query(
      `INSERT INTO applications_applications (
         id, user_id, job_id, goal_id, material_ids, status, submission_idempotency_key,
         evidence, timeline, deadline_at, manual_reason, version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         job_id = EXCLUDED.job_id,
         goal_id = EXCLUDED.goal_id,
         material_ids = EXCLUDED.material_ids,
         status = EXCLUDED.status,
         submission_idempotency_key = EXCLUDED.submission_idempotency_key,
         evidence = EXCLUDED.evidence,
         timeline = EXCLUDED.timeline,
         deadline_at = EXCLUDED.deadline_at,
         manual_reason = EXCLUDED.manual_reason,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at
       WHERE applications_applications.user_id = $2`,
      [
        application.id,
        userId,
        application.job_id,
        application.goal_id,
        application.material_ids,
        application.status,
        application.submission_idempotency_key,
        JSON.stringify(application.evidence),
        JSON.stringify(application.timeline),
        application.deadline_at ?? null,
        application.manual_reason ?? null,
        application.version,
        application.created_at,
        application.updated_at,
      ],
    );
  }

  async listApplications(userId: string): Promise<Application[]> {
    const { rows } = await this.executor.query<ApplicationRow>(
      'SELECT * FROM applications_applications WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return rows.map(mapApplication);
  }

  async findApplicationIdBySubmissionKey(
    userId: string,
    submissionKey: string,
  ): Promise<string | undefined> {
    const { rows } = await this.executor.query<{ id: string }>(
      'SELECT id FROM applications_applications WHERE user_id = $1 AND submission_idempotency_key = $2',
      [userId, submissionKey],
    );
    return rows[0]?.id;
  }

  async saveManualTask(userId: string, task: ManualApplicationTask): Promise<void> {
    if (task.user_id !== userId) {
      throw new Error('Applications store tenant mismatch.');
    }
    await this.executor.query(
      `INSERT INTO applications_manual_tasks (
         id, user_id, application_id, application_version, status, manual_reason, package,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         application_id = EXCLUDED.application_id,
         application_version = EXCLUDED.application_version,
         status = EXCLUDED.status,
         manual_reason = EXCLUDED.manual_reason,
         package = EXCLUDED.package,
         updated_at = EXCLUDED.updated_at
       WHERE applications_manual_tasks.user_id = $2`,
      [
        task.id,
        userId,
        task.resource.id,
        task.resource.version ?? 1,
        task.status,
        task.manual_reason,
        JSON.stringify(task.package),
        task.created_at,
        task.updated_at,
      ],
    );
  }

  async listManualTasks(userId: string, applicationId?: string): Promise<ManualApplicationTask[]> {
    if (applicationId) {
      const { rows } = await this.executor.query<ManualTaskRow>(
        `SELECT * FROM applications_manual_tasks
         WHERE user_id = $1 AND application_id = $2 ORDER BY created_at, id`,
        [userId, applicationId],
      );
      return rows.map(mapManualTask);
    }
    const { rows } = await this.executor.query<ManualTaskRow>(
      'SELECT * FROM applications_manual_tasks WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return rows.map(mapManualTask);
  }

  async getIdempotencyRecord(
    userId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<ApplicationIdempotencyRecord | undefined> {
    const { rows } = await this.executor.query<IdempotencyRow>(
      `SELECT request_hash, response, audit_event_id FROM applications_idempotency
       WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [userId, operation, idempotencyKey],
    );
    return rows[0]
      ? {
          request_hash: rows[0].request_hash,
          response: rows[0].response,
          audit_event_id: rows[0].audit_event_id,
        }
      : undefined;
  }

  async saveIdempotencyRecord(
    userId: string,
    operation: string,
    idempotencyKey: string,
    record: ApplicationIdempotencyRecord,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO applications_idempotency (
         user_id, operation, idempotency_key, request_hash, response, audit_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        userId,
        operation,
        idempotencyKey,
        record.request_hash,
        JSON.stringify(record.response),
        record.audit_event_id,
      ],
    );
  }

  async getReceipt(
    userId: string,
    receiptKey: string,
  ): Promise<ApplicationReceiptRecord | undefined> {
    const { rows } = await this.executor.query<ReceiptRow>(
      `SELECT receipt_id, request_hash, response FROM applications_receipts
       WHERE user_id = $1 AND receipt_key = $2`,
      [userId, receiptKey],
    );
    return rows[0]
      ? {
          receipt_id: rows[0].receipt_id,
          request_hash: rows[0].request_hash,
          response: rows[0].response,
        }
      : undefined;
  }

  async saveReceipt(
    userId: string,
    receiptKey: string,
    record: ApplicationReceiptRecord,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO applications_receipts
         (user_id, receipt_id, receipt_key, request_hash, response)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, record.receipt_id, receiptKey, record.request_hash, JSON.stringify(record.response)],
    );
  }

  async appendAuditEvent(userId: string, event: ApplicationAuditEvent): Promise<void> {
    await this.executor.query(
      `INSERT INTO applications_audit_events (
         event_id, user_id, actor, action, resource, outcome, from_status, to_status,
         reason_code, replayed_from_event_id, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        event.event_id,
        userId,
        JSON.stringify(event.actor),
        event.action,
        JSON.stringify(event.resource),
        event.outcome,
        event.from_status ?? null,
        event.to_status ?? null,
        event.reason_code ?? null,
        event.replayed_from_event_id ?? null,
        event.occurred_at,
      ],
    );
  }

  async listAuditEvents(userId: string): Promise<ApplicationAuditEvent[]> {
    const { rows } = await this.executor.query<AuditRow>(
      'SELECT * FROM applications_audit_events WHERE user_id = $1 ORDER BY occurred_at, event_id',
      [userId],
    );
    return rows.map(mapAudit);
  }
}
