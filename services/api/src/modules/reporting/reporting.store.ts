import { Injectable } from '@nestjs/common';

import type { ReportingStore, StoredSourceRecord } from './reporting-store.interface';
import type { DailyReport, Notification, NotificationPreferences } from './reporting.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

@Injectable()
export class InMemoryReportingStore implements ReportingStore {
  private readonly preferences = new Map<string, NotificationPreferences>();
  private readonly notifications = new Map<string, Notification>();
  private readonly notificationDedupe = new Map<string, string>();
  private readonly sourceRecords = new Map<string, StoredSourceRecord>();
  private readonly reports = new Map<string, DailyReport>();

  async withTransaction<T>(operation: (store: ReportingStore) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async getPreferences(userId: string): Promise<NotificationPreferences | undefined> {
    const preferences = this.preferences.get(userId);
    return preferences ? clone(preferences) : undefined;
  }

  async savePreferences(userId: string, preferences: NotificationPreferences): Promise<void> {
    this.preferences.set(userId, clone(preferences));
  }

  async getNotification(userId: string, notificationId: string): Promise<Notification | undefined> {
    const notification = this.notifications.get(notificationId);
    return notification && notification.user_id === userId ? clone(notification) : undefined;
  }

  async saveNotification(userId: string, notification: Notification): Promise<void> {
    if (notification.user_id !== userId) {
      throw new Error('Reporting store tenant mismatch.');
    }
    this.notifications.set(notification.id, clone(notification));
  }

  async listNotifications(userId: string): Promise<Notification[]> {
    return [...this.notifications.values()]
      .filter((notification) => notification.user_id === userId)
      .map(clone);
  }

  async findNotificationIdByDedupeKey(
    userId: string,
    type: string,
    dedupeKey: string,
  ): Promise<string | undefined> {
    return this.notificationDedupe.get(this.dedupeMapKey(userId, type, dedupeKey));
  }

  async saveNotificationDedupe(
    userId: string,
    type: string,
    dedupeKey: string,
    notificationId: string,
  ): Promise<void> {
    this.notificationDedupe.set(this.dedupeMapKey(userId, type, dedupeKey), notificationId);
  }

  async getSourceRecord(userId: string, recordId: string): Promise<StoredSourceRecord | undefined> {
    const record = this.sourceRecords.get(this.sourceRecordMapKey(userId, recordId));
    return record ? clone(record) : undefined;
  }

  async saveSourceRecord(
    userId: string,
    recordId: string,
    record: StoredSourceRecord,
  ): Promise<void> {
    if (record.value.user_id !== userId) {
      throw new Error('Reporting store tenant mismatch.');
    }
    this.sourceRecords.set(this.sourceRecordMapKey(userId, recordId), clone(record));
  }

  async listSourceRecords(userId: string) {
    return [...this.sourceRecords.values()]
      .filter((record) => record.value.user_id === userId)
      .map((record) => clone(record.value));
  }

  async getReport(
    userId: string,
    localDate: string,
    timeZone: string,
  ): Promise<DailyReport | undefined> {
    const report = this.reports.get(this.reportMapKey(userId, localDate, timeZone));
    return report ? clone(report) : undefined;
  }

  async saveReport(userId: string, report: DailyReport): Promise<void> {
    if (report.user_id !== userId) {
      throw new Error('Reporting store tenant mismatch.');
    }
    this.reports.set(this.reportMapKey(userId, report.local_date, report.time_zone), clone(report));
  }

  private dedupeMapKey(userId: string, type: string, dedupeKey: string): string {
    return `${userId}:${type}:${dedupeKey}`;
  }

  private sourceRecordMapKey(userId: string, recordId: string): string {
    return `${userId}:${recordId}`;
  }

  private reportMapKey(userId: string, localDate: string, timeZone: string): string {
    return `${userId}:${localDate}:${timeZone}`;
  }
}
