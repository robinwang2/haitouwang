import { describe, expect, it } from 'vitest';

import {
  InMemoryReportingStore,
  type DailyReport,
  type Notification,
  type NotificationPreferences,
  type ReportingSourceRecord,
} from '../../src/modules/reporting';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const NOW = '2026-07-31T12:00:00.000Z';

function preferences(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    time_zone: 'UTC',
    enabled_channels: ['in_app', 'email'],
    unsubscribed_types: [],
    ...overrides,
  };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: '60000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    type: 'high_match',
    status: 'pending',
    dedupe_key: 'dedupe-1',
    channel: 'in_app',
    source_ref: { type: 'job', id: '20000000-0000-4000-8000-000000000001' },
    created_at: NOW,
    ...overrides,
  };
}

function sourceRecord(overrides: Partial<ReportingSourceRecord> = {}): ReportingSourceRecord {
  return {
    record_id: '70000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    category: 'discovered',
    source_ref: { type: 'job', id: '20000000-0000-4000-8000-000000000001' },
    occurred_at: NOW,
    ...overrides,
  };
}

function dailyReport(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    id: '80000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    local_date: '2026-07-31',
    time_zone: 'UTC',
    generated_at: NOW,
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

describe('InMemoryReportingStore', () => {
  it('round-trips notification preferences per tenant', async () => {
    const store = new InMemoryReportingStore();
    expect(await store.getPreferences(USER_ID)).toBeUndefined();

    await store.savePreferences(USER_ID, preferences());
    expect(await store.getPreferences(USER_ID)).toEqual(preferences());
    expect(await store.getPreferences(OTHER_USER_ID)).toBeUndefined();
  });

  it('round-trips a notification and enforces tenant scoping on reads', async () => {
    const store = new InMemoryReportingStore();
    await store.saveNotification(USER_ID, notification());

    expect(await store.getNotification(USER_ID, notification().id)).toEqual(notification());
    expect(await store.getNotification(OTHER_USER_ID, notification().id)).toBeUndefined();
    expect((await store.listNotifications(USER_ID)).map((row) => row.id)).toEqual([
      notification().id,
    ]);
    expect(await store.listNotifications(OTHER_USER_ID)).toEqual([]);
  });

  it('resolves a notification id via its dedupe key, scoped by tenant', async () => {
    const store = new InMemoryReportingStore();
    await store.saveNotification(USER_ID, notification());
    await store.saveNotificationDedupe(USER_ID, 'high_match', 'dedupe-1', notification().id);

    expect(await store.findNotificationIdByDedupeKey(USER_ID, 'high_match', 'dedupe-1')).toBe(
      notification().id,
    );
    expect(
      await store.findNotificationIdByDedupeKey(OTHER_USER_ID, 'high_match', 'dedupe-1'),
    ).toBeUndefined();
  });

  it('round-trips source records and lists them scoped by tenant', async () => {
    const store = new InMemoryReportingStore();
    const record = { hash: 'hash-1', value: sourceRecord() };
    await store.saveSourceRecord(USER_ID, sourceRecord().record_id, record);

    expect(await store.getSourceRecord(USER_ID, sourceRecord().record_id)).toEqual(record);
    expect(await store.getSourceRecord(OTHER_USER_ID, sourceRecord().record_id)).toBeUndefined();
    expect((await store.listSourceRecords(USER_ID)).map((row) => row.record_id)).toEqual([
      sourceRecord().record_id,
    ]);
    expect(await store.listSourceRecords(OTHER_USER_ID)).toEqual([]);
  });

  it('round-trips a daily report keyed by user, local date and time zone', async () => {
    const store = new InMemoryReportingStore();
    await store.saveReport(USER_ID, dailyReport());

    expect(await store.getReport(USER_ID, '2026-07-31', 'UTC')).toEqual(dailyReport());
    expect(await store.getReportById(USER_ID, dailyReport().id)).toEqual(dailyReport());
    expect(await store.getReportById(OTHER_USER_ID, dailyReport().id)).toBeUndefined();
    expect(await store.getReport(OTHER_USER_ID, '2026-07-31', 'UTC')).toBeUndefined();
    expect(await store.getReport(USER_ID, '2026-08-01', 'UTC')).toBeUndefined();
  });

  it('commits writes performed inside withTransaction (single in-process store)', async () => {
    const store = new InMemoryReportingStore();
    await store.withTransaction(async (scoped) => {
      await scoped.saveNotification(USER_ID, notification());
    });
    expect(await store.getNotification(USER_ID, notification().id)).toEqual(notification());
  });
});
