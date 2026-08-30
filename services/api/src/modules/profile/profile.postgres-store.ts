import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { IdempotencyRecord, ProfileStore } from './profile-store.interface';
import type { AuditEvent, Fact, FileMetadata, Goal, VersionRecord } from './profile.types';

type Executor = Pool | PoolClient;

interface GoalRow extends QueryResultRow {
  id: string;
  user_id: string;
  name: string;
  title_keywords: string[];
  locations: string[];
  employment_types: string[];
  salary: Goal['salary'] | null;
  work_authorization_rule: Goal['work_authorization_rule'] | null;
  locale: string | null;
  status: Goal['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface FactRow extends QueryResultRow {
  id: string;
  user_id: string;
  kind: Fact['kind'];
  value: Fact['value'];
  scope: Fact['scope'];
  status: Fact['status'];
  valid_from: Date | null;
  valid_until: Date | null;
  source: Fact['source'];
  confirmed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface FileRow extends QueryResultRow {
  id: string;
  user_id: string;
  purpose: FileMetadata['purpose'];
  display_name: string;
  media_type: FileMetadata['media_type'];
  byte_size: number;
  sha256: string;
  scan_status: FileMetadata['scan_status'];
  version: number;
  created_at: Date;
}

interface VersionRow<T> extends QueryResultRow {
  resource_id: string;
  version: number;
  recorded_at: Date;
  snapshot: T;
}

interface AuditRow extends QueryResultRow {
  event_id: string;
  user_id: string;
  occurred_at: Date;
  actor: AuditEvent['actor'];
  action: string;
  resource: AuditEvent['resource'];
  outcome: AuditEvent['outcome'];
  request_id: string;
  correlation_id: string;
  causation_id: string | null;
  from_status: string | null;
  to_status: string | null;
  changed_fields: string[];
  reason_code: string | null;
  replayed_from_event_id: string | null;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response: unknown;
  audit_event_id: string;
  resource_id: string;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function mapGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    title_keywords: row.title_keywords,
    locations: row.locations,
    employment_types: row.employment_types as Goal['employment_types'],
    status: row.status,
    version: row.version,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.salary ? { salary: row.salary } : {}),
    ...(row.work_authorization_rule
      ? { work_authorization_rule: row.work_authorization_rule }
      : {}),
    ...(row.locale ? { locale: row.locale } : {}),
  };
}

function mapFact(row: FactRow): Fact {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind,
    value: row.value,
    scope: row.scope,
    status: row.status,
    source: row.source,
    version: row.version,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.valid_from ? { valid_from: toIso(row.valid_from) } : {}),
    ...(row.valid_until ? { valid_until: toIso(row.valid_until) } : {}),
    ...(row.confirmed_at ? { confirmed_at: toIso(row.confirmed_at) } : {}),
  };
}

function mapFile(row: FileRow): FileMetadata {
  return {
    id: row.id,
    user_id: row.user_id,
    purpose: row.purpose,
    display_name: row.display_name,
    media_type: row.media_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    scan_status: row.scan_status,
    version: row.version,
    created_at: toIso(row.created_at),
  };
}

function mapVersion<T>(row: VersionRow<T>): VersionRecord<T> {
  return {
    resource_id: row.resource_id,
    version: row.version,
    recorded_at: toIso(row.recorded_at),
    snapshot: row.snapshot,
  };
}

function mapAudit(row: AuditRow): AuditEvent {
  return {
    event_id: row.event_id,
    occurred_at: toIso(row.occurred_at),
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    outcome: row.outcome,
    tenant_id: row.user_id,
    request_id: row.request_id,
    correlation_id: row.correlation_id,
    changed_fields: row.changed_fields,
    ...(row.causation_id ? { causation_id: row.causation_id } : {}),
    ...(row.from_status ? { from_status: row.from_status } : {}),
    ...(row.to_status ? { to_status: row.to_status } : {}),
    ...(row.reason_code ? { reason_code: row.reason_code } : {}),
    ...(row.replayed_from_event_id ? { replayed_from_event_id: row.replayed_from_event_id } : {}),
  };
}

function mapIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    request_hash: row.request_hash,
    response: row.response,
    audit_event_id: row.audit_event_id,
    resource_id: row.resource_id,
  };
}

/**
 * Postgres-backed implementation of ProfileStore. Every statement scopes its WHERE
 * clause by user_id; row-level tenant isolation is enforced in SQL, not only in the
 * calling service. Instances returned from withTransaction share one client/transaction.
 */
export class PostgresProfileStore implements ProfileStore {
  constructor(
    readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  async withTransaction<T>(operation: (store: ProfileStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresProfileStore(this.pool, client);
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

  async getGoal(userId: string, goalId: string): Promise<Goal | undefined> {
    const { rows } = await this.executor.query<GoalRow>(
      'SELECT * FROM profile_goals WHERE id = $1 AND user_id = $2',
      [goalId, userId],
    );
    return rows[0] ? mapGoal(rows[0]) : undefined;
  }

  async listGoals(userId: string, includeArchived = false): Promise<Goal[]> {
    const { rows } = await this.executor.query<GoalRow>(
      `SELECT * FROM profile_goals
       WHERE user_id = $1 AND (status <> 'archived' OR $2)
       ORDER BY created_at, id`,
      [userId, includeArchived],
    );
    return rows.map(mapGoal);
  }

  async saveGoal(userId: string, goal: Goal): Promise<void> {
    this.assertUser(userId, goal.user_id);
    await this.executor.query(
      `INSERT INTO profile_goals (
         id, user_id, name, title_keywords, locations, employment_types,
         salary, work_authorization_rule, locale, status, version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         title_keywords = EXCLUDED.title_keywords,
         locations = EXCLUDED.locations,
         employment_types = EXCLUDED.employment_types,
         salary = EXCLUDED.salary,
         work_authorization_rule = EXCLUDED.work_authorization_rule,
         locale = EXCLUDED.locale,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at
       WHERE profile_goals.user_id = $2`,
      [
        goal.id,
        userId,
        goal.name,
        goal.title_keywords,
        goal.locations,
        goal.employment_types,
        goal.salary ? JSON.stringify(goal.salary) : null,
        goal.work_authorization_rule ?? null,
        goal.locale ?? null,
        goal.status,
        goal.version,
        goal.created_at,
        goal.updated_at,
      ],
    );
  }

  async deleteGoal(userId: string, goalId: string): Promise<boolean> {
    const result = await this.executor.query(
      'DELETE FROM profile_goals WHERE id = $1 AND user_id = $2',
      [goalId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getFact(userId: string, factId: string): Promise<Fact | undefined> {
    const { rows } = await this.executor.query<FactRow>(
      'SELECT * FROM profile_facts WHERE id = $1 AND user_id = $2',
      [factId, userId],
    );
    return rows[0] ? mapFact(rows[0]) : undefined;
  }

  async listFacts(userId: string, includeDeleted = false): Promise<Fact[]> {
    const { rows } = await this.executor.query<FactRow>(
      `SELECT * FROM profile_facts
       WHERE user_id = $1 AND (status <> 'deleted' OR $2)
       ORDER BY created_at, id`,
      [userId, includeDeleted],
    );
    return rows.map(mapFact);
  }

  async saveFact(userId: string, fact: Fact): Promise<void> {
    this.assertUser(userId, fact.user_id);
    await this.executor.query(
      `INSERT INTO profile_facts (
         id, user_id, kind, value, scope, status, valid_from, valid_until,
         source, confirmed_at, version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         value = EXCLUDED.value,
         scope = EXCLUDED.scope,
         status = EXCLUDED.status,
         valid_from = EXCLUDED.valid_from,
         valid_until = EXCLUDED.valid_until,
         source = EXCLUDED.source,
         confirmed_at = EXCLUDED.confirmed_at,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at
       WHERE profile_facts.user_id = $2`,
      [
        fact.id,
        userId,
        fact.kind,
        JSON.stringify(fact.value),
        JSON.stringify(fact.scope),
        fact.status,
        fact.valid_from ?? null,
        fact.valid_until ?? null,
        JSON.stringify(fact.source),
        fact.confirmed_at ?? null,
        fact.version,
        fact.created_at,
        fact.updated_at,
      ],
    );
  }

  async deleteFact(userId: string, factId: string): Promise<boolean> {
    const result = await this.executor.query(
      'DELETE FROM profile_facts WHERE id = $1 AND user_id = $2',
      [factId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getFile(userId: string, fileId: string): Promise<FileMetadata | undefined> {
    const { rows } = await this.executor.query<FileRow>(
      'SELECT * FROM profile_files WHERE id = $1 AND user_id = $2',
      [fileId, userId],
    );
    return rows[0] ? mapFile(rows[0]) : undefined;
  }

  async listFiles(userId: string): Promise<FileMetadata[]> {
    const { rows } = await this.executor.query<FileRow>(
      'SELECT * FROM profile_files WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return rows.map(mapFile);
  }

  async saveFile(userId: string, file: FileMetadata): Promise<void> {
    this.assertUser(userId, file.user_id);
    await this.executor.query(
      `INSERT INTO profile_files (
         id, user_id, purpose, display_name, media_type, byte_size, sha256, scan_status, version, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         purpose = EXCLUDED.purpose,
         display_name = EXCLUDED.display_name,
         media_type = EXCLUDED.media_type,
         byte_size = EXCLUDED.byte_size,
         sha256 = EXCLUDED.sha256,
         scan_status = EXCLUDED.scan_status,
         version = EXCLUDED.version
       WHERE profile_files.user_id = $2`,
      [
        file.id,
        userId,
        file.purpose,
        file.display_name,
        file.media_type,
        file.byte_size,
        file.sha256,
        file.scan_status,
        file.version,
        file.created_at,
      ],
    );
  }

  async deleteFile(userId: string, fileId: string): Promise<boolean> {
    const result = await this.executor.query(
      'DELETE FROM profile_files WHERE id = $1 AND user_id = $2',
      [fileId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listGoalVersions(userId: string, goalId: string): Promise<VersionRecord<Goal>[]> {
    const { rows } = await this.executor.query<VersionRow<Goal>>(
      'SELECT resource_id, version, recorded_at, snapshot FROM profile_goal_versions WHERE resource_id = $1 AND user_id = $2 ORDER BY version',
      [goalId, userId],
    );
    return rows.map((row) => mapVersion(row));
  }

  async appendGoalVersion(userId: string, version: VersionRecord<Goal>): Promise<void> {
    this.assertUser(userId, version.snapshot.user_id);
    await this.executor.query(
      'INSERT INTO profile_goal_versions (resource_id, user_id, version, recorded_at, snapshot) VALUES ($1,$2,$3,$4,$5)',
      [
        version.resource_id,
        userId,
        version.version,
        version.recorded_at,
        JSON.stringify(version.snapshot),
      ],
    );
  }

  async deleteGoalVersions(userId: string, goalId: string): Promise<void> {
    await this.executor.query(
      'DELETE FROM profile_goal_versions WHERE resource_id = $1 AND user_id = $2',
      [goalId, userId],
    );
  }

  async listFactVersions(userId: string, factId: string): Promise<VersionRecord<Fact>[]> {
    const { rows } = await this.executor.query<VersionRow<Fact>>(
      'SELECT resource_id, version, recorded_at, snapshot FROM profile_fact_versions WHERE resource_id = $1 AND user_id = $2 ORDER BY version',
      [factId, userId],
    );
    return rows.map((row) => mapVersion(row));
  }

  async appendFactVersion(userId: string, version: VersionRecord<Fact>): Promise<void> {
    this.assertUser(userId, version.snapshot.user_id);
    await this.executor.query(
      'INSERT INTO profile_fact_versions (resource_id, user_id, version, recorded_at, snapshot) VALUES ($1,$2,$3,$4,$5)',
      [
        version.resource_id,
        userId,
        version.version,
        version.recorded_at,
        JSON.stringify(version.snapshot),
      ],
    );
  }

  async replaceFactVersions(userId: string, versions: VersionRecord<Fact>[]): Promise<void> {
    if (versions.length === 0) return;
    versions.forEach((version) => this.assertUser(userId, version.snapshot.user_id));
    const resourceId = versions[0].resource_id;
    await this.executor.query(
      'DELETE FROM profile_fact_versions WHERE resource_id = $1 AND user_id = $2',
      [resourceId, userId],
    );
    for (const version of versions) {
      await this.executor.query(
        'INSERT INTO profile_fact_versions (resource_id, user_id, version, recorded_at, snapshot) VALUES ($1,$2,$3,$4,$5)',
        [
          version.resource_id,
          userId,
          version.version,
          version.recorded_at,
          JSON.stringify(version.snapshot),
        ],
      );
    }
  }

  async deleteFactVersions(userId: string, factId: string): Promise<void> {
    await this.executor.query(
      'DELETE FROM profile_fact_versions WHERE resource_id = $1 AND user_id = $2',
      [factId, userId],
    );
  }

  async listFileVersions(userId: string, fileId: string): Promise<VersionRecord<FileMetadata>[]> {
    const { rows } = await this.executor.query<VersionRow<FileMetadata>>(
      'SELECT resource_id, version, recorded_at, snapshot FROM profile_file_versions WHERE resource_id = $1 AND user_id = $2 ORDER BY version',
      [fileId, userId],
    );
    return rows.map((row) => mapVersion(row));
  }

  async appendFileVersion(userId: string, version: VersionRecord<FileMetadata>): Promise<void> {
    this.assertUser(userId, version.snapshot.user_id);
    await this.executor.query(
      'INSERT INTO profile_file_versions (resource_id, user_id, version, recorded_at, snapshot) VALUES ($1,$2,$3,$4,$5)',
      [
        version.resource_id,
        userId,
        version.version,
        version.recorded_at,
        JSON.stringify(version.snapshot),
      ],
    );
  }

  async deleteFileVersions(userId: string, fileId: string): Promise<void> {
    await this.executor.query(
      'DELETE FROM profile_file_versions WHERE resource_id = $1 AND user_id = $2',
      [fileId, userId],
    );
  }

  async listAuditEvents(userId: string): Promise<AuditEvent[]> {
    const { rows } = await this.executor.query<AuditRow>(
      'SELECT * FROM profile_audit_events WHERE user_id = $1 ORDER BY occurred_at, event_id',
      [userId],
    );
    return rows.map(mapAudit);
  }

  async appendAuditEvent(userId: string, event: AuditEvent): Promise<void> {
    this.assertUser(userId, event.tenant_id);
    await this.executor.query(
      `INSERT INTO profile_audit_events (
         event_id, user_id, occurred_at, actor, action, resource, outcome,
         request_id, correlation_id, causation_id, from_status, to_status,
         changed_fields, reason_code, replayed_from_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        event.event_id,
        userId,
        event.occurred_at,
        JSON.stringify(event.actor),
        event.action,
        JSON.stringify(event.resource),
        event.outcome,
        event.request_id,
        event.correlation_id,
        event.causation_id ?? null,
        event.from_status ?? null,
        event.to_status ?? null,
        event.changed_fields,
        event.reason_code ?? null,
        event.replayed_from_event_id ?? null,
      ],
    );
  }

  async getIdempotency(
    userId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    const { rows } = await this.executor.query<IdempotencyRow>(
      'SELECT request_hash, response, audit_event_id, resource_id FROM profile_idempotency WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3',
      [userId, operation, idempotencyKey],
    );
    return rows[0] ? mapIdempotency(rows[0]) : undefined;
  }

  async saveIdempotency(
    userId: string,
    operation: string,
    idempotencyKey: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO profile_idempotency (
         user_id, operation, idempotency_key, request_hash, response, audit_event_id, resource_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, operation, idempotency_key) DO UPDATE SET
         request_hash = EXCLUDED.request_hash,
         response = EXCLUDED.response,
         audit_event_id = EXCLUDED.audit_event_id,
         resource_id = EXCLUDED.resource_id
       WHERE profile_idempotency.user_id = $1`,
      [
        userId,
        operation,
        idempotencyKey,
        record.request_hash,
        JSON.stringify(record.response),
        record.audit_event_id,
        record.resource_id,
      ],
    );
  }

  async deleteIdempotencyForResource(userId: string, resourceId: string): Promise<void> {
    await this.executor.query(
      'DELETE FROM profile_idempotency WHERE user_id = $1 AND resource_id = $2',
      [userId, resourceId],
    );
  }

  async deleteIdempotencyForUser(userId: string): Promise<void> {
    await this.executor.query('DELETE FROM profile_idempotency WHERE user_id = $1', [userId]);
  }

  async deleteUserData(userId: string): Promise<{ goals: number; facts: number; files: number }> {
    const goals = await this.executor.query('DELETE FROM profile_goals WHERE user_id = $1', [
      userId,
    ]);
    const facts = await this.executor.query('DELETE FROM profile_facts WHERE user_id = $1', [
      userId,
    ]);
    const files = await this.executor.query('DELETE FROM profile_files WHERE user_id = $1', [
      userId,
    ]);
    await this.executor.query('DELETE FROM profile_goal_versions WHERE user_id = $1', [userId]);
    await this.executor.query('DELETE FROM profile_fact_versions WHERE user_id = $1', [userId]);
    await this.executor.query('DELETE FROM profile_file_versions WHERE user_id = $1', [userId]);
    return {
      goals: goals.rowCount ?? 0,
      facts: facts.rowCount ?? 0,
      files: files.rowCount ?? 0,
    };
  }

  private assertUser(expected: string, actual: string): void {
    if (expected !== actual) {
      throw new Error('Profile store tenant mismatch.');
    }
  }
}
