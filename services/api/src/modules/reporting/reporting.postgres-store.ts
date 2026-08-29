import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { ResourceRef } from '../applications';
import type { ReportingStore, StoredSourceRecord } from './reporting-store.interface';
import type {
  DailyReport,
  DailyReportCategory,
  DailyReportSection,
  Notification,
  NotificationChannel,
  NotificationPreferences,
  NotificationStatus,
  NotificationType,
  QuietHours,
} from './reporting.types';

type Executor = Pool | PoolClient;

interface PreferencesRow extends QueryResultRow {
  user_id: string;
  time_zone: string;
  enabled_channels: NotificationChannel[];
  unsubscribed_types: NotificationType[];
  quiet_hours: QuietHours | null;
  muted_until: Date | null;
}

interface NotificationRow extends QueryResultRow {
  id: string;
  user_id: string;
  type: NotificationType;
  status: NotificationStatus;
  dedupe_key: string;
  channel: NotificationChannel;
  scheduled_at: Date | null;
  source_ref: ResourceRef;
  created_at: Date;
  sent_at: Date | null;
}

interface SourceRecordRow extends QueryResultRow {
  user_id: string;
  record_id: string;
  hash: string;
  category: DailyReportCategory;
  source_ref: ResourceRef;
  occurred_at: Date;
  reason_code: string | null;
}

interface ReportRow extends QueryResultRow {
  id: string;
  user_id: string;
  local_date: string;
  time_zone: string;
  generated_at: Date;
  sections: Record<DailyReportCategory, DailyReportSection>;
  source_record_count: number;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function mapPreferences(row: PreferencesRow): NotificationPreferences {
  return {
    time_zone: row.time_zone,
    enabled_channels: row.enabled_channels,
    unsubscribed_types: row.unsubscribed_types,
    ...(row.quiet_hours ? { quiet_hours: row.quiet_hours } : {}),
    ...(row.muted_until ? { muted_until: toIso(row.muted_until) } : {}),
  };
}

function mapNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    status: row.status,
    dedupe_key: row.dedupe_key,
    channel: row.channel,
    ...(row.scheduled_at ? { scheduled_at: toIso(row.scheduled_at) } : {}),
    source_ref: row.source_ref,
    created_at: toIso(row.created_at),
    ...(row.sent_at ? { sent_at: toIso(row.sent_at) } : {}),
  };
}

function mapSourceRecord(row: SourceRecordRow): StoredSourceRecord {
  return {
    hash: row.hash,
    value: {
      record_id: row.record_id,
      user_id: row.user_id,
      category: row.category,
      source_ref: row.source_ref,
      occurred_at: toIso(row.occurred_at),
      ...(row.reason_code ? { reason_code: row.reason_code } : {}),
    },
  };
}

function mapReport(row: ReportRow): DailyReport {
  return {
    id: row.id,
    user_id: row.user_id,
    local_date: row.local_date,
    time_zone: row.time_zone,
    generated_at: toIso(row.generated_at),
    sections: row.sections,
    source_record_count: row.source_record_count,
  };
}

/**
 * Postgres-backed implementation of ReportingStore. Every statement scopes its WHERE
 * clause by user_id. The notification-dedupe and daily-report lookup keys are enforced
 * as SQL PRIMARY KEY / UNIQUE constraints - see infra/db/migrations/applications (the
 * reporting_* tables live alongside applications_* in that same migrations directory).
 */
export class PostgresReportingStore implements ReportingStore {
  constructor(
    readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  async withTransaction<T>(operation: (store: ReportingStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresReportingStore(this.pool, client);
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

  async getPreferences(userId: string): Promise<NotificationPreferences | undefined> {
    const { rows } = await this.executor.query<PreferencesRow>(
      'SELECT * FROM reporting_preferences WHERE user_id = $1',
      [userId],
    );
    return rows[0] ? mapPreferences(rows[0]) : undefined;
  }

  async savePreferences(userId: string, preferences: NotificationPreferences): Promise<void> {
    await this.executor.query(
      `INSERT INTO reporting_preferences (
         user_id, time_zone, enabled_channels, unsubscribed_types, quiet_hours, muted_until
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET
         time_zone = EXCLUDED.time_zone,
         enabled_channels = EXCLUDED.enabled_channels,
         unsubscribed_types = EXCLUDED.unsubscribed_types,
         quiet_hours = EXCLUDED.quiet_hours,
         muted_until = EXCLUDED.muted_until
       WHERE reporting_preferences.user_id = $1`,
      [
        userId,
        preferences.time_zone,
        preferences.enabled_channels,
        preferences.unsubscribed_types,
        preferences.quiet_hours ? JSON.stringify(preferences.quiet_hours) : null,
        preferences.muted_until ?? null,
      ],
    );
  }

  async getNotification(userId: string, notificationId: string): Promise<Notification | undefined> {
    const { rows } = await this.executor.query<NotificationRow>(
      'SELECT * FROM reporting_notifications WHERE id = $1 AND user_id = $2',
      [notificationId, userId],
    );
    return rows[0] ? mapNotification(rows[0]) : undefined;
  }

  async saveNotification(userId: string, notification: Notification): Promise<void> {
    if (notification.user_id !== userId) {
      throw new Error('Reporting store tenant mismatch.');
    }
    await this.executor.query(
      `INSERT INTO reporting_notifications (
         id, user_id, type, status, dedupe_key, channel, scheduled_at, source_ref,
         created_at, sent_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         dedupe_key = EXCLUDED.dedupe_key,
         channel = EXCLUDED.channel,
         scheduled_at = EXCLUDED.scheduled_at,
         source_ref = EXCLUDED.source_ref,
         sent_at = EXCLUDED.sent_at
       WHERE reporting_notifications.user_id = $2`,
      [
        notification.id,
        userId,
        notification.type,
        notification.status,
        notification.dedupe_key,
        notification.channel,
        notification.scheduled_at ?? null,
        JSON.stringify(notification.source_ref),
        notification.created_at,
        notification.sent_at ?? null,
      ],
    );
  }

  async listNotifications(userId: string): Promise<Notification[]> {
    const { rows } = await this.executor.query<NotificationRow>(
      'SELECT * FROM reporting_notifications WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return rows.map(mapNotification);
  }

  async findNotificationIdByDedupeKey(
    userId: string,
    type: string,
    dedupeKey: string,
  ): Promise<string | undefined> {
    const { rows } = await this.executor.query<{ notification_id: string }>(
      `SELECT notification_id FROM reporting_notification_dedupe
       WHERE user_id = $1 AND type = $2 AND dedupe_key = $3`,
      [userId, type, dedupeKey],
    );
    return rows[0]?.notification_id;
  }

  async saveNotificationDedupe(
    userId: string,
    type: string,
    dedupeKey: string,
    notificationId: string,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO reporting_notification_dedupe (user_id, type, dedupe_key, notification_id)
       VALUES ($1,$2,$3,$4)`,
      [userId, type, dedupeKey, notificationId],
    );
  }

  async getSourceRecord(userId: string, recordId: string): Promise<StoredSourceRecord | undefined> {
    const { rows } = await this.executor.query<SourceRecordRow>(
      'SELECT * FROM reporting_source_records WHERE user_id = $1 AND record_id = $2',
      [userId, recordId],
    );
    return rows[0] ? mapSourceRecord(rows[0]) : undefined;
  }

  async saveSourceRecord(
    userId: string,
    recordId: string,
    record: StoredSourceRecord,
  ): Promise<void> {
    if (record.value.user_id !== userId) {
      throw new Error('Reporting store tenant mismatch.');
    }
    await this.executor.query(
      `INSERT INTO reporting_source_records (
         user_id, record_id, hash, category, source_ref, occurred_at, reason_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        userId,
        recordId,
        record.hash,
        record.value.category,
        JSON.stringify(record.value.source_ref),
        record.value.occurred_at,
        record.value.reason_code ?? null,
      ],
    );
  }

  async listSourceRecords(userId: string) {
    const { rows } = await this.executor.query<SourceRecordRow>(
      'SELECT * FROM reporting_source_records WHERE user_id = $1 ORDER BY occurred_at, record_id',
      [userId],
    );
    return rows.map((row) => mapSourceRecord(row).value);
  }

  async getReport(
    userId: string,
    localDate: string,
    timeZone: string,
  ): Promise<DailyReport | undefined> {
    const { rows } = await this.executor.query<ReportRow>(
      `SELECT * FROM reporting_reports WHERE user_id = $1 AND local_date = $2 AND time_zone = $3`,
      [userId, localDate, timeZone],
    );
    return rows[0] ? mapReport(rows[0]) : undefined;
  }

  async getReportById(userId: string, reportId: string): Promise<DailyReport | undefined> {
    const { rows } = await this.executor.query<ReportRow>(
      'SELECT * FROM reporting_reports WHERE user_id = $1 AND id = $2',
      [userId, reportId],
    );
    return rows[0] ? mapReport(rows[0]) : undefined;
  }

  async saveReport(userId: string, report: DailyReport): Promise<void> {
    if (report.user_id !== userId) {
      throw new Error('Reporting store tenant mismatch.');
    }
    await this.executor.query(
      `INSERT INTO reporting_reports (
         id, user_id, local_date, time_zone, generated_at, sections, source_record_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        report.id,
        userId,
        report.local_date,
        report.time_zone,
        report.generated_at,
        JSON.stringify(report.sections),
        report.source_record_count,
      ],
    );
  }
}
