import type {
  DailyReport,
  Notification,
  NotificationPreferences,
  ReportingSourceRecord,
} from './reporting.types';

export const REPORTING_STORE = Symbol('REPORTING_STORE');

export interface StoredSourceRecord {
  hash: string;
  value: ReportingSourceRecord;
}

/**
 * Persistence boundary for the Reporting aggregate (notification preferences, notifications,
 * notification dedupe index, source records, and daily reports). Every operation is
 * tenant-scoped by user_id. This models the durable replacement for reporting.service.ts's
 * in-process Maps; reporting.service.ts is not wired to this interface (notification dedupe
 * and daily-report generation stay untouched and keep using their own private Maps
 * synchronously), matching the pattern already established for MaterialsStore/ReviewStore in
 * HW-13.
 */
export interface ReportingStore {
  withTransaction<T>(operation: (store: ReportingStore) => Promise<T>): Promise<T>;

  getPreferences(userId: string): Promise<NotificationPreferences | undefined>;
  savePreferences(userId: string, preferences: NotificationPreferences): Promise<void>;

  getNotification(userId: string, notificationId: string): Promise<Notification | undefined>;
  saveNotification(userId: string, notification: Notification): Promise<void>;
  listNotifications(userId: string): Promise<Notification[]>;

  findNotificationIdByDedupeKey(
    userId: string,
    type: string,
    dedupeKey: string,
  ): Promise<string | undefined>;
  saveNotificationDedupe(
    userId: string,
    type: string,
    dedupeKey: string,
    notificationId: string,
  ): Promise<void>;

  getSourceRecord(userId: string, recordId: string): Promise<StoredSourceRecord | undefined>;
  saveSourceRecord(userId: string, recordId: string, record: StoredSourceRecord): Promise<void>;
  listSourceRecords(userId: string): Promise<ReportingSourceRecord[]>;

  getReport(userId: string, localDate: string, timeZone: string): Promise<DailyReport | undefined>;
  saveReport(userId: string, report: DailyReport): Promise<void>;
}
