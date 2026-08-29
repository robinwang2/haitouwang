import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApplicationsService, PostgresApplicationsStore } from '../../src/modules/applications';
import type {
  Application,
  ApplicationAuditEvent,
  ManualApplicationTask,
} from '../../src/modules/applications';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[applications.postgres-store] DATABASE_URL is not set - skipping PostgresApplicationsStore ' +
      'integration tests. This sandbox has no Docker/Postgres available (see ' +
      'docs/qa/mvp-report.md); set DATABASE_URL to a disposable Postgres instance to exercise ' +
      'the real SQL implementation.',
  );
}

// applications_* and reporting_* tables both live under infra/db/migrations/applications.
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/applications',
);

async function migrationSql(suffix: '.up.sql' | '.down.sql'): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(suffix)).sort();
  return Promise.all(files.map((file) => readFile(path.join(MIGRATIONS_DIR, file), 'utf8')));
}

async function resetSchema(pool: Pool): Promise<void> {
  for (const sql of (await migrationSql('.down.sql')).reverse()) {
    await pool.query(sql);
  }
}

function applicationFixture(userId: string, overrides: Partial<Application> = {}): Application {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: userId,
    job_id: randomUUID(),
    goal_id: randomUUID(),
    material_ids: [randomUUID()],
    status: 'draft',
    submission_idempotency_key: `submission-key-${randomUUID()}`,
    evidence: [],
    timeline: [
      {
        id: randomUUID(),
        from_status: null,
        to_status: 'draft',
        actor: { type: 'user', id: userId },
        occurred_at: now,
        reason_code: 'application_created',
      },
    ],
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function manualTaskFixture(
  userId: string,
  application: Application,
  overrides: Partial<ManualApplicationTask> = {},
): ManualApplicationTask {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: userId,
    type: 'manual_application',
    status: 'requires_human',
    resource: { type: 'application', id: application.id, version: application.version },
    attempt: 0,
    max_attempts: 1,
    manual_reason: 'captcha',
    package: {
      target_url: 'https://example.com/apply',
      material_refs: [{ type: 'material', id: randomUUID() }],
      answer_refs: [],
      risk_codes: [],
      unresolved_items: [],
      recovery_action: 'user_complete_locally',
    },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function auditEventFixture(
  userId: string,
  application: Application,
  overrides: Partial<ApplicationAuditEvent> = {},
): ApplicationAuditEvent {
  return {
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    actor: { type: 'user', id: userId },
    action: 'application.created',
    resource: { type: 'application', id: application.id, version: application.version },
    outcome: 'succeeded',
    to_status: 'draft',
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)('PostgresApplicationsStore integration', () => {
  let pool: Pool;
  let store: PostgresApplicationsStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(pool);
    for (const sql of await migrationSql('.up.sql')) {
      await pool.query(sql);
    }
    store = new PostgresApplicationsStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  it('persists ApplicationsService state across service instances', async () => {
    const userId = randomUUID();
    const firstService = new ApplicationsService(store);
    const created = await firstService.createApplication(
      userId,
      {
        job_id: randomUUID(),
        goal_id: randomUUID(),
        material_ids: [randomUUID()],
        submission_idempotency_key: `submission:${randomUUID()}`,
      },
      {
        actor: { type: 'user', id: userId },
        idempotency_key: `create:${randomUUID()}`,
      },
    );

    const restartedService = new ApplicationsService(store);
    expect(await restartedService.getApplication(userId, created.id)).toEqual(created);
    expect(await restartedService.getAuditEvents(userId)).toHaveLength(1);
  });

  it('round-trips an application and enforces user_id scoping in SQL', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const application = applicationFixture(userId);

    await store.saveApplication(userId, application);

    expect(await store.getApplication(userId, application.id)).toEqual(application);
    expect(await store.getApplication(otherUserId, application.id)).toBeUndefined();
    expect((await store.listApplications(userId)).map((row) => row.id)).toEqual([application.id]);
    expect(await store.listApplications(otherUserId)).toEqual([]);
    expect(
      await store.findApplicationIdBySubmissionKey(userId, application.submission_idempotency_key),
    ).toBe(application.id);
    expect(
      await store.findApplicationIdBySubmissionKey(
        otherUserId,
        application.submission_idempotency_key,
      ),
    ).toBeUndefined();
  });

  it('rejects a second application for the same tenant reusing a submission key (unique constraint)', async () => {
    const userId = randomUUID();
    const submissionKey = `submission-key-${randomUUID()}`;
    await store.saveApplication(
      userId,
      applicationFixture(userId, { submission_idempotency_key: submissionKey }),
    );

    await expect(
      store.saveApplication(
        userId,
        applicationFixture(userId, { submission_idempotency_key: submissionKey }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows the same submission key to be reused by a different tenant', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const submissionKey = `submission-key-${randomUUID()}`;
    await store.saveApplication(
      userId,
      applicationFixture(userId, { submission_idempotency_key: submissionKey }),
    );

    await expect(
      store.saveApplication(
        otherUserId,
        applicationFixture(otherUserId, { submission_idempotency_key: submissionKey }),
      ),
    ).resolves.toBeUndefined();
  });

  it('round-trips manual tasks scoped by tenant and application id', async () => {
    const userId = randomUUID();
    const application = applicationFixture(userId);
    await store.saveApplication(userId, application);
    const task = manualTaskFixture(userId, application);
    await store.saveManualTask(userId, task);

    expect((await store.listManualTasks(userId)).map((row) => row.id)).toEqual([task.id]);
    expect((await store.listManualTasks(userId, application.id)).map((row) => row.id)).toEqual([
      task.id,
    ]);
    expect(await store.listManualTasks(randomUUID())).toEqual([]);
  });

  it('round-trips idempotency records keyed by user, operation and idempotency key', async () => {
    const userId = randomUUID();
    const record = { request_hash: 'hash-1', response: { ok: true }, audit_event_id: randomUUID() };
    await store.saveIdempotencyRecord(userId, 'createApplication', 'key-1', record);

    expect(await store.getIdempotencyRecord(userId, 'createApplication', 'key-1')).toEqual(record);
    expect(
      await store.getIdempotencyRecord(randomUUID(), 'createApplication', 'key-1'),
    ).toBeUndefined();
  });

  it('rejects a second insert reusing the same receipt id (unique constraint)', async () => {
    const userId = randomUUID();
    const application = applicationFixture(userId);
    await store.saveApplication(userId, application);
    const receiptId = randomUUID();
    const record = {
      receipt_id: receiptId,
      request_hash: 'hash-1',
      response: { receipt_id: receiptId, application, replayed: false },
    };

    await store.saveReceipt(userId, 'agent:command:1', record);
    expect(await store.getReceipt(userId, 'agent:command:1')).toEqual(record);

    await expect(store.saveReceipt(userId, 'agent:command:2', record)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('persists and lists audit events scoped by tenant', async () => {
    const userId = randomUUID();
    const application = applicationFixture(userId);
    await store.saveApplication(userId, application);
    const event = auditEventFixture(userId, application);
    await store.appendAuditEvent(userId, event);

    expect((await store.listAuditEvents(userId)).map((row) => row.event_id)).toEqual([
      event.event_id,
    ]);
    expect(await store.listAuditEvents(randomUUID())).toEqual([]);
  });

  it('rolls back all writes when the transaction callback throws', async () => {
    const userId = randomUUID();
    const application = applicationFixture(userId);

    await expect(
      store.withTransaction(async (scoped) => {
        await scoped.saveApplication(userId, application);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.getApplication(userId, application.id)).toBeUndefined();
  });
});
