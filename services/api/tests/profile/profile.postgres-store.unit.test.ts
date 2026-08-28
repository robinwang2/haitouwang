import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresProfileStore } from '../../src/modules/profile';
import type { AuditEvent, Fact, Goal, VersionRecord } from '../../src/modules/profile';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[profile.postgres-store] DATABASE_URL is not set - skipping PostgresProfileStore integration ' +
      'tests. This sandbox has no Docker/Postgres available (see docs/qa/mvp-report.md); set ' +
      'DATABASE_URL to a disposable Postgres instance to exercise the real SQL implementation.',
  );
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/profile',
);

async function migrationSql(suffix: '.up.sql' | '.down.sql'): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(suffix)).sort();
  return Promise.all(files.map((file) => readFile(path.join(MIGRATIONS_DIR, file), 'utf8')));
}

async function resetSchema(pool: Pool): Promise<void> {
  const downSqls = (await migrationSql('.down.sql')).reverse();
  for (const sql of downSqls) {
    await pool.query(sql);
  }
}

function goalFixture(userId: string, overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: userId,
    name: 'Backend roles',
    title_keywords: ['Backend Engineer'],
    locations: ['Remote'],
    employment_types: ['full_time'],
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)('PostgresProfileStore integration', () => {
  let pool: Pool;
  let store: PostgresProfileStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(pool);
    const upSqls = await migrationSql('.up.sql');
    for (const sql of upSqls) {
      await pool.query(sql);
    }
    store = new PostgresProfileStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  it('round-trips a goal and enforces user_id scoping in SQL', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const goal = goalFixture(userId, {
      salary: { currency: 'USD', minimum: 100_000, period: 'year' },
    });

    await store.saveGoal(userId, goal);

    expect(await store.getGoal(userId, goal.id)).toEqual(goal);
    expect(await store.getGoal(otherUserId, goal.id)).toBeUndefined();
    expect((await store.listGoals(otherUserId)).length).toBe(0);
    expect((await store.listGoals(userId)).map((row) => row.id)).toEqual([goal.id]);

    expect(await store.deleteGoal(otherUserId, goal.id)).toBe(false);
    expect(await store.getGoal(userId, goal.id)).toEqual(goal);
    expect(await store.deleteGoal(userId, goal.id)).toBe(true);
    expect(await store.getGoal(userId, goal.id)).toBeUndefined();
  });

  it('persists version history, audit events and idempotency records scoped by tenant', async () => {
    const userId = randomUUID();
    const goal = goalFixture(userId);
    await store.saveGoal(userId, goal);

    const version: VersionRecord<Goal> = {
      resource_id: goal.id,
      version: 1,
      recorded_at: new Date().toISOString(),
      snapshot: goal,
    };
    await store.appendGoalVersion(userId, version);
    expect((await store.listGoalVersions(userId, goal.id)).map((row) => row.snapshot.id)).toEqual([
      goal.id,
    ]);
    expect(await store.listGoalVersions(randomUUID(), goal.id)).toEqual([]);

    const event: AuditEvent = {
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor: { type: 'user', id: userId },
      action: 'goal.created',
      resource: { type: 'goal', id: goal.id },
      outcome: 'succeeded',
      tenant_id: userId,
      request_id: randomUUID(),
      correlation_id: randomUUID(),
      changed_fields: ['name'],
    };
    await store.appendAuditEvent(userId, event);
    expect((await store.listAuditEvents(userId)).map((row) => row.event_id)).toEqual([
      event.event_id,
    ]);
    expect(await store.listAuditEvents(randomUUID())).toEqual([]);

    await store.saveIdempotency(userId, 'createGoal', 'integration-test-key-000001', {
      request_hash: 'hash',
      response: { id: goal.id },
      audit_event_id: event.event_id,
      resource_id: goal.id,
    });
    expect(await store.getIdempotency(userId, 'createGoal', 'integration-test-key-000001')).toEqual(
      {
        request_hash: 'hash',
        response: { id: goal.id },
        audit_event_id: event.event_id,
        resource_id: goal.id,
      },
    );
    expect(
      await store.getIdempotency(randomUUID(), 'createGoal', 'integration-test-key-000001'),
    ).toBeUndefined();

    await store.deleteIdempotencyForResource(userId, goal.id);
    expect(
      await store.getIdempotency(userId, 'createGoal', 'integration-test-key-000001'),
    ).toBeUndefined();
  });

  it('rolls back all writes when the transaction callback throws', async () => {
    const userId = randomUUID();
    const goal = goalFixture(userId);

    await expect(
      store.withTransaction(async (scoped) => {
        await scoped.saveGoal(userId, goal);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.getGoal(userId, goal.id)).toBeUndefined();
  });

  it('commits writes from a successful transaction', async () => {
    const userId = randomUUID();
    const goal = goalFixture(userId);

    await store.withTransaction(async (scoped) => {
      await scoped.saveGoal(userId, goal);
    });

    expect(await store.getGoal(userId, goal.id)).toEqual(goal);
  });

  it('scrubs fact version history via replaceFactVersions and cascades on deleteUserData', async () => {
    const userId = randomUUID();
    const now = new Date().toISOString();
    const fact: Fact = {
      id: randomUUID(),
      user_id: userId,
      kind: 'identity',
      value: { legal_name: 'Sensitive Name' },
      scope: { use: 'manual_only' },
      status: 'pending_confirmation',
      source: { type: 'user', reference: 'profile-form' },
      version: 2,
      created_at: now,
      updated_at: now,
    };
    await store.saveFact(userId, fact);
    await store.appendFactVersion(userId, {
      resource_id: fact.id,
      version: 1,
      recorded_at: now,
      snapshot: { ...fact, version: 1 },
    });
    await store.replaceFactVersions(userId, [
      { resource_id: fact.id, version: 2, recorded_at: now, snapshot: fact },
    ]);
    const history = await store.listFactVersions(userId, fact.id);
    expect(history.map((row) => row.version)).toEqual([2]);

    const counts = await store.deleteUserData(userId);
    expect(counts).toEqual({ goals: 0, facts: 1, files: 0 });
    expect(await store.getFact(userId, fact.id)).toBeUndefined();
    expect(await store.listFactVersions(userId, fact.id)).toEqual([]);
  });
});
