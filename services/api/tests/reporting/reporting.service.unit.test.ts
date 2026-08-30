import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InMemoryReportingStore, ReportingService } from '../../src/modules/reporting';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const JOB_ID = '20000000-0000-4000-8000-000000000001';

async function expectErrorCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code} to be thrown.`);
}

describe('ReportingService notifications', () => {
  it('persists notification state across service instances through the injected store', async () => {
    const store = new InMemoryReportingStore();
    const firstService = new ReportingService(store);
    const created = await firstService.requestNotification(USER_ID, {
      type: 'high_match',
      dedupe_key: 'restart:job:42',
      channel: 'in_app',
      source_ref: { type: 'job', id: JOB_ID, version: 1 },
    });

    const restartedService = new ReportingService(store);
    expect(await restartedService.listNotifications(USER_ID)).toEqual([created]);
    expect(await restartedService.buildDeliveryPayload(USER_ID, created.id)).toMatchObject({
      notification_id: created.id,
      source_ref: created.source_ref,
    });
  });

  it('deduplicates the same event and suppresses it during local quiet hours', async () => {
    const now = new Date('2026-07-31T06:30:00.000Z');
    const service = new ReportingService(new InMemoryReportingStore(), {
      clock: { now: () => now },
    });
    await service.setNotificationPreferences(USER_ID, {
      time_zone: 'America/Los_Angeles',
      enabled_channels: ['email', 'in_app'],
      unsubscribed_types: [],
      quiet_hours: { start: '22:00', end: '08:00' },
    });
    const request = {
      type: 'high_match' as const,
      dedupe_key: 'match:job:42',
      channel: 'email' as const,
      source_ref: { type: 'job' as const, id: JOB_ID, version: 3 },
    };

    const first = await service.requestNotification(USER_ID, request);
    const replay = await service.requestNotification(USER_ID, request);

    expect(replay).toEqual(first);
    expect(await service.listNotifications(USER_ID)).toHaveLength(1);
    expect(first).toMatchObject({ status: 'suppressed' });
    expect(first.scheduled_at).toBeUndefined();
    expect(await service.buildDeliveryPayload(USER_ID, first.id)).toEqual({
      notification_id: first.id,
      notification_type: 'high_match',
      channel: 'email',
      source_ref: { type: 'job', id: JOB_ID, version: 3 },
    });
  });

  it('suppresses unsubscribed types and never accepts a conflicting dedupe source', async () => {
    const service = new ReportingService(new InMemoryReportingStore());
    await service.setNotificationPreferences(USER_ID, {
      time_zone: 'UTC',
      enabled_channels: ['email'],
      unsubscribed_types: ['login_expired'],
    });
    const request = {
      type: 'login_expired' as const,
      dedupe_key: 'login:platform:1',
      channel: 'email' as const,
      source_ref: { type: 'agent' as const, id: randomUUID(), version: 1 },
    };
    const notification = await service.requestNotification(USER_ID, request);
    expect(notification.status).toBe('suppressed');
    await expectErrorCode(
      () =>
        service.requestNotification(USER_ID, {
          ...request,
          source_ref: { type: 'agent', id: randomUUID(), version: 1 },
        }),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });
});

describe('ReportingService daily report traceability', () => {
  it('derives every count from local-day source records and returns those records', async () => {
    const service = new ReportingService(new InMemoryReportingStore(), {
      clock: { now: () => new Date('2026-07-31T20:00:00.000Z') },
    });
    const included = [
      {
        record_id: randomUUID(),
        user_id: USER_ID,
        category: 'discovered' as const,
        source_ref: { type: 'job' as const, id: JOB_ID, version: 1 },
        occurred_at: '2026-07-31T07:30:00.000Z',
      },
      {
        record_id: randomUUID(),
        user_id: USER_ID,
        category: 'manual_tasks' as const,
        source_ref: { type: 'task' as const, id: randomUUID(), version: 1 },
        occurred_at: '2026-08-01T06:59:00.000Z',
        reason_code: 'captcha',
      },
      {
        record_id: randomUUID(),
        user_id: USER_ID,
        category: 'exceptions' as const,
        source_ref: { type: 'task' as const, id: randomUUID(), version: 1 },
        occurred_at: '2026-07-31T18:00:00.000Z',
        reason_code: 'task_failed',
      },
    ];
    await Promise.all(included.map((record) => service.recordSource(record)));
    await service.recordSource({
      record_id: randomUUID(),
      user_id: USER_ID,
      category: 'submitted',
      source_ref: { type: 'application', id: randomUUID(), version: 8 },
      occurred_at: '2026-08-01T07:00:00.000Z',
    });

    const report = await service.generateDailyReport(USER_ID, '2026-07-31', 'America/Los_Angeles');
    expect(report.source_record_count).toBe(3);
    expect(report.sections.discovered.count).toBe(report.sections.discovered.records.length);
    expect(report.sections.manual_tasks).toMatchObject({ count: 1 });
    expect(report.sections.exceptions).toMatchObject({ count: 1 });
    expect(report.sections.submitted).toMatchObject({ count: 0, records: [] });
    expect(await service.getReportSourceRecords(USER_ID, report.id)).toHaveLength(3);
  });

  it('records report source inputs idempotently and rejects changed replays', async () => {
    const service = new ReportingService(new InMemoryReportingStore());
    const record = {
      record_id: randomUUID(),
      user_id: USER_ID,
      category: 'filtered' as const,
      source_ref: { type: 'job' as const, id: JOB_ID, version: 1 },
      occurred_at: '2026-07-31T12:00:00.000Z',
      reason_code: 'hard_gate',
    };
    expect(await service.recordSource(record)).toEqual(await service.recordSource(record));
    await expectErrorCode(
      () => service.recordSource({ ...record, reason_code: 'risk' }),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });
});
