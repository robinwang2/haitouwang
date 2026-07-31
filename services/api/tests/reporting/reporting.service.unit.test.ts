import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ReportingService } from '../../src/modules/reporting';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const JOB_ID = '20000000-0000-4000-8000-000000000001';

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code} to be thrown.`);
}

describe('ReportingService notifications', () => {
  it('deduplicates the same event and suppresses it during local quiet hours', () => {
    const now = new Date('2026-07-31T06:30:00.000Z');
    const service = new ReportingService({ clock: { now: () => now } });
    service.setNotificationPreferences(USER_ID, {
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

    const first = service.requestNotification(USER_ID, request);
    const replay = service.requestNotification(USER_ID, request);

    expect(replay).toEqual(first);
    expect(service.listNotifications(USER_ID)).toHaveLength(1);
    expect(first).toMatchObject({ status: 'suppressed' });
    expect(first.scheduled_at).toBeUndefined();
    expect(service.buildDeliveryPayload(USER_ID, first.id)).toEqual({
      notification_id: first.id,
      notification_type: 'high_match',
      channel: 'email',
      source_ref: { type: 'job', id: JOB_ID, version: 3 },
    });
  });

  it('suppresses unsubscribed types and never accepts a conflicting dedupe source', () => {
    const service = new ReportingService();
    service.setNotificationPreferences(USER_ID, {
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
    const notification = service.requestNotification(USER_ID, request);
    expect(notification.status).toBe('suppressed');
    expectErrorCode(
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
  it('derives every count from local-day source records and returns those records', () => {
    const service = new ReportingService({
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
    included.forEach((record) => service.recordSource(record));
    service.recordSource({
      record_id: randomUUID(),
      user_id: USER_ID,
      category: 'submitted',
      source_ref: { type: 'application', id: randomUUID(), version: 8 },
      occurred_at: '2026-08-01T07:00:00.000Z',
    });

    const report = service.generateDailyReport(USER_ID, '2026-07-31', 'America/Los_Angeles');
    expect(report.source_record_count).toBe(3);
    expect(report.sections.discovered.count).toBe(report.sections.discovered.records.length);
    expect(report.sections.manual_tasks).toMatchObject({ count: 1 });
    expect(report.sections.exceptions).toMatchObject({ count: 1 });
    expect(report.sections.submitted).toMatchObject({ count: 0, records: [] });
    expect(service.getReportSourceRecords(USER_ID, report.id)).toHaveLength(3);
  });

  it('records report source inputs idempotently and rejects changed replays', () => {
    const service = new ReportingService();
    const record = {
      record_id: randomUUID(),
      user_id: USER_ID,
      category: 'filtered' as const,
      source_ref: { type: 'job' as const, id: JOB_ID, version: 1 },
      occurred_at: '2026-07-31T12:00:00.000Z',
      reason_code: 'hard_gate',
    };
    expect(service.recordSource(record)).toEqual(service.recordSource(record));
    expectErrorCode(
      () => service.recordSource({ ...record, reason_code: 'risk' }),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });
});
