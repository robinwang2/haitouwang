import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresReportingStore, ReportingService } from '../../src/modules/reporting';
import type {
  DailyReport,
  Notification,
  NotificationPreferences,
  ReportingSourceRecord,
} from '../../src/modules/reporting';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[reporting.postgres-store] DATABASE_URL is not set - skipping PostgresReportingStore ' +
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

function preferencesFixture(
  overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    time_zone: 'UTC',
    enabled_channels: ['in_app', 'email'],
    unsubscribed_types: [],
    ...overrides,
  };
}

function notificationFixture(userId: string, overrides: Partial<Notification> = {}): Notification {
  return {
    id: randomUUID(),
    user_id: userId,
    type: 'high_match',
    status: 'pending',
    dedupe_key: `dedupe-${randomUUID()}`,
    channel: 'in_app',
    source_ref: { type: 'job', id: randomUUID() },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function sourceRecordFixture(
  userId: string,
  overrides: Partial<ReportingSourceRecord> = {},
): ReportingSourceRecord {
  return {
    record_id: randomUUID(),
    user_id: userId,
    category: 'discovered',
    source_ref: { type: 'job', id: randomUUID() },
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

function dailyReportFixture(userId: string, overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    id: randomUUID(),
    user_id: userId,
    local_date: '2026-07-31',
    time_zone: 'UTC',
    generated_at: new Date().toISOString(),
    sections: {
      discovered: { count: 0, records: [] },
      deduplicated: { count: 0, records: [] },
      submitted: { count: 0, records: [] },
      pending_confirmation: { count: 0, records: [] },
      manual_tasks: { count: 0, records: [] },
      filtered: { count: 0, records: [] },
      exceptions: { count: 0, records: [] },
    },
    source_record_count: 0,
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)('PostgresReportingStore integration', () => {
  let pool: Pool;
  let store: PostgresReportingStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(pool);
    for (const sql of await migrationSql('.up.sql')) {
      await pool.query(sql);
    }
    store = new PostgresReportingStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  it('persists ReportingService state across service instances', async () => {
    const userId = randomUUID();
    const firstService = new ReportingService(store);
    const created = await firstService.requestNotification(userId, {
      type: 'high_match',
      dedupe_key: `match:${randomUUID()}`,
      channel: 'in_app',
      source_ref: { type: 'job', id: randomUUID(), version: 1 },
    });

    const restartedService = new ReportingService(store);
    expect(await restartedService.listNotifications(userId)).toEqual([created]);
  });

  it('round-trips notification preferences and enforces user_id scoping in SQL', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    expect(await store.getPreferences(userId)).toBeUndefined();

    await store.savePreferences(userId, preferencesFixture());
    expect(await store.getPreferences(userId)).toEqual(preferencesFixture());
    expect(await store.getPreferences(otherUserId)).toBeUndefined();
  });

  it('round-trips a notification and enforces user_id scoping in SQL', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const notification = notificationFixture(userId);
    await store.saveNotification(userId, notification);

    expect(await store.getNotification(userId, notification.id)).toEqual(notification);
    expect(await store.getNotification(otherUserId, notification.id)).toBeUndefined();
    expect((await store.listNotifications(userId)).map((row) => row.id)).toEqual([notification.id]);
    expect(await store.listNotifications(otherUserId)).toEqual([]);
  });

  it('resolves a notification id via its dedupe key, scoped by tenant', async () => {
    const userId = randomUUID();
    const notification = notificationFixture(userId);
    await store.saveNotification(userId, notification);
    await store.saveNotificationDedupe(
      userId,
      notification.type,
      notification.dedupe_key,
      notification.id,
    );

    expect(
      await store.findNotificationIdByDedupeKey(userId, notification.type, notification.dedupe_key),
    ).toBe(notification.id);
    expect(
      await store.findNotificationIdByDedupeKey(
        randomUUID(),
        notification.type,
        notification.dedupe_key,
      ),
    ).toBeUndefined();
  });

  it('round-trips source records and lists them scoped by tenant', async () => {
    const userId = randomUUID();
    const record = sourceRecordFixture(userId);
    await store.saveSourceRecord(userId, record.record_id, { hash: 'hash-1', value: record });

    expect(await store.getSourceRecord(userId, record.record_id)).toEqual({
      hash: 'hash-1',
      value: record,
    });
    expect(await store.getSourceRecord(randomUUID(), record.record_id)).toBeUndefined();
    expect((await store.listSourceRecords(userId)).map((row) => row.record_id)).toEqual([
      record.record_id,
    ]);
  });

  it('round-trips a daily report keyed by user, local date and time zone (unique constraint)', async () => {
    const userId = randomUUID();
    const report = dailyReportFixture(userId);
    await store.saveReport(userId, report);

    expect(await store.getReport(userId, report.local_date, report.time_zone)).toEqual(report);
    expect(
      await store.getReport(randomUUID(), report.local_date, report.time_zone),
    ).toBeUndefined();

    await expect(
      store.saveReport(userId, dailyReportFixture(userId, { local_date: report.local_date })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rolls back all writes when the transaction callback throws', async () => {
    const userId = randomUUID();
    const notification = notificationFixture(userId);

    await expect(
      store.withTransaction(async (scoped) => {
        await scoped.saveNotification(userId, notification);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.getNotification(userId, notification.id)).toBeUndefined();
  });
});
