import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { REPORTING_STORE } from './reporting-store.interface';
import type { ReportingStore } from './reporting-store.interface';
import { ReportingError } from './reporting.errors';
import type {
  DailyReport,
  DailyReportCategory,
  DailyReportSection,
  Notification,
  NotificationDeliveryPayload,
  NotificationPreferences,
  NotificationRequest,
  QuietHours,
  ReportingServiceOptions,
  ReportingSourceRecord,
} from './reporting.types';

export const REPORTING_SERVICE_OPTIONS = Symbol('REPORTING_SERVICE_OPTIONS');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES: readonly DailyReportCategory[] = [
  'discovered',
  'deduplicated',
  'submitted',
  'pending_confirmation',
  'manual_tasks',
  'filtered',
  'exceptions',
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

@Injectable()
export class ReportingService {
  private readonly clock: { now(): Date };
  private readonly idFactory: () => string;

  public constructor(
    @Inject(REPORTING_STORE)
    private readonly store: ReportingStore,
    @Optional()
    @Inject(REPORTING_SERVICE_OPTIONS)
    options: ReportingServiceOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.idFactory = options.id_factory ?? randomUUID;
  }

  public async setNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    this.validateUuid(userId, 'user_id');
    this.validatePreferences(preferences);
    await this.store.savePreferences(userId, preferences);
    return clone(preferences);
  }

  public async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    this.validateUuid(userId, 'user_id');
    return this.getPreferences(this.store, userId);
  }

  public async requestNotification(
    userId: string,
    request: NotificationRequest,
  ): Promise<Notification> {
    this.validateUuid(userId, 'user_id');
    this.validateNotificationRequest(request);
    return this.store.withTransaction(async (store) => {
      const priorId = await store.findNotificationIdByDedupeKey(
        userId,
        request.type,
        request.dedupe_key,
      );
      if (priorId) {
        const prior = await store.getNotification(userId, priorId);
        if (!prior)
          throw new ReportingError('RESOURCE_NOT_FOUND', 'Notification was not found.', 404);
        if (
          prior.channel !== request.channel ||
          hash(prior.source_ref) !== hash(request.source_ref)
        ) {
          throw new ReportingError(
            'IDEMPOTENCY_KEY_REUSED',
            'The notification dedupe key was reused for a different source or channel.',
            409,
          );
        }
        return clone(prior);
      }

      const now = this.clock.now();
      const preferences = await this.getPreferences(store, userId);
      const suppressed = this.shouldSuppress(request, preferences, now);
      const requestedAt = request.scheduled_at ? new Date(request.scheduled_at) : now;
      const scheduledAt = suppressed
        ? undefined
        : nextAllowedInstant(
            requestedAt > now ? requestedAt : now,
            preferences.time_zone,
            preferences.quiet_hours,
          );
      const notification: Notification = {
        id: this.idFactory(),
        user_id: userId,
        type: request.type,
        status: suppressed ? 'suppressed' : 'pending',
        dedupe_key: request.dedupe_key,
        channel: request.channel,
        ...(scheduledAt ? { scheduled_at: scheduledAt.toISOString() } : {}),
        source_ref: clone(request.source_ref),
        created_at: now.toISOString(),
      };
      await store.saveNotification(userId, notification);
      await store.saveNotificationDedupe(userId, request.type, request.dedupe_key, notification.id);
      return notification;
    });
  }

  public async markNotificationSent(userId: string, notificationId: string): Promise<Notification> {
    return this.store.withTransaction(async (store) => {
      const current = await this.requireNotification(store, userId, notificationId);
      if (current.status === 'sent') return current;
      if (current.status !== 'pending') {
        throw new ReportingError(
          'STATE_TRANSITION_INVALID',
          `Notification cannot transition from ${current.status} to sent.`,
          409,
        );
      }
      const updated: Notification = {
        ...current,
        status: 'sent',
        sent_at: this.clock.now().toISOString(),
      };
      await store.saveNotification(userId, updated);
      return updated;
    });
  }

  public async markNotificationFailed(
    userId: string,
    notificationId: string,
  ): Promise<Notification> {
    return this.store.withTransaction(async (store) => {
      const current = await this.requireNotification(store, userId, notificationId);
      if (current.status === 'failed') return current;
      if (current.status !== 'pending') {
        throw new ReportingError(
          'STATE_TRANSITION_INVALID',
          `Notification cannot transition from ${current.status} to failed.`,
          409,
        );
      }
      const updated: Notification = { ...current, status: 'failed' };
      await store.saveNotification(userId, updated);
      return updated;
    });
  }

  public async retryNotification(userId: string, notificationId: string): Promise<Notification> {
    return this.store.withTransaction(async (store) => {
      const current = await this.requireNotification(store, userId, notificationId);
      if (current.status !== 'failed') {
        throw new ReportingError(
          'STATE_TRANSITION_INVALID',
          `Notification cannot transition from ${current.status} to pending.`,
          409,
        );
      }
      const preferences = await this.getPreferences(store, userId);
      const request: NotificationRequest = {
        type: current.type,
        dedupe_key: current.dedupe_key,
        channel: current.channel,
        source_ref: current.source_ref,
      };
      const now = this.clock.now();
      const suppressed = this.shouldSuppress(request, preferences, now);
      const next = nextAllowedInstant(now, preferences.time_zone, preferences.quiet_hours);
      const updated: Notification = {
        ...current,
        status: suppressed ? 'suppressed' : 'pending',
        ...(suppressed ? {} : { scheduled_at: next.toISOString() }),
      };
      await store.saveNotification(userId, updated);
      return updated;
    });
  }

  public async listNotifications(userId: string): Promise<Notification[]> {
    this.validateUuid(userId, 'user_id');
    return (await this.store.listNotifications(userId))
      .filter((notification) => notification.user_id === userId)
      .sort((left, right) =>
        `${left.created_at}:${left.id}`.localeCompare(`${right.created_at}:${right.id}`),
      )
      .map(clone);
  }

  public async buildDeliveryPayload(
    userId: string,
    notificationId: string,
  ): Promise<NotificationDeliveryPayload> {
    const notification = await this.requireNotification(this.store, userId, notificationId);
    return {
      notification_id: notification.id,
      notification_type: notification.type,
      channel: notification.channel,
      source_ref: clone(notification.source_ref),
    };
  }

  public async recordSource(record: ReportingSourceRecord): Promise<ReportingSourceRecord> {
    this.validateSourceRecord(record);
    const recordHash = hash(record);
    return this.store.withTransaction(async (store) => {
      const prior = await store.getSourceRecord(record.user_id, record.record_id);
      if (prior) {
        if (prior.hash !== recordHash) {
          throw new ReportingError(
            'IDEMPOTENCY_KEY_REUSED',
            'The reporting source record id was reused with different content.',
            409,
          );
        }
        return clone(prior.value);
      }
      await store.saveSourceRecord(record.user_id, record.record_id, {
        hash: recordHash,
        value: clone(record),
      });
      return clone(record);
    });
  }

  public async generateDailyReport(
    userId: string,
    localDate: string,
    timeZone: string,
  ): Promise<DailyReport> {
    this.validateUuid(userId, 'user_id');
    if (!DATE_PATTERN.test(localDate)) throw this.validation('local_date must use YYYY-MM-DD.');
    this.validateTimeZone(timeZone);
    return this.store.withTransaction(async (store) => {
      const prior = await store.getReport(userId, localDate, timeZone);
      if (prior) return clone(prior);

      const selected = (await store.listSourceRecords(userId))
        .filter((record) => localDateAt(new Date(record.occurred_at), timeZone) === localDate)
        .sort((left, right) =>
          `${left.occurred_at}:${left.record_id}`.localeCompare(
            `${right.occurred_at}:${right.record_id}`,
          ),
        );
      const sections = Object.fromEntries(
        CATEGORIES.map((category) => {
          const records = selected
            .filter((record) => record.category === category)
            .map(({ record_id, source_ref, occurred_at, reason_code }) => ({
              record_id,
              source_ref: clone(source_ref),
              occurred_at,
              ...(reason_code ? { reason_code } : {}),
            }));
          const section: DailyReportSection = { count: records.length, records };
          return [category, section];
        }),
      ) as Record<DailyReportCategory, DailyReportSection>;
      const report: DailyReport = {
        id: this.idFactory(),
        user_id: userId,
        local_date: localDate,
        time_zone: timeZone,
        generated_at: this.clock.now().toISOString(),
        sections,
        source_record_count: selected.length,
      };
      await store.saveReport(userId, report);
      return report;
    });
  }

  public async getReportSourceRecords(
    userId: string,
    reportId: string,
  ): Promise<ReportingSourceRecord[]> {
    const report = await this.store.getReportById(userId, reportId);
    if (!report) throw new ReportingError('RESOURCE_NOT_FOUND', 'Daily report was not found.', 404);
    const ids = new Set(
      Object.values(report.sections).flatMap((section) =>
        section.records.map((record) => record.record_id),
      ),
    );
    return (await this.store.listSourceRecords(userId))
      .filter((record) => ids.has(record.record_id))
      .sort((left, right) => left.record_id.localeCompare(right.record_id))
      .map(clone);
  }

  private async requireNotification(
    store: ReportingStore,
    userId: string,
    notificationId: string,
  ): Promise<Notification> {
    this.validateUuid(userId, 'user_id');
    this.validateUuid(notificationId, 'notification_id');
    const notification = await store.getNotification(userId, notificationId);
    if (!notification) {
      throw new ReportingError('RESOURCE_NOT_FOUND', 'Notification was not found.', 404);
    }
    return clone(notification);
  }

  private async getPreferences(
    store: ReportingStore,
    userId: string,
  ): Promise<NotificationPreferences> {
    return clone((await store.getPreferences(userId)) ?? defaultPreferences());
  }

  private shouldSuppress(
    request: NotificationRequest,
    preferences: NotificationPreferences,
    now: Date,
  ): boolean {
    const requestedAt = request.scheduled_at ? new Date(request.scheduled_at) : now;
    const deliveryAt = requestedAt > now ? requestedAt : now;
    return (
      request.data_deleted === true ||
      !preferences.enabled_channels.includes(request.channel) ||
      preferences.unsubscribed_types.includes(request.type) ||
      (preferences.muted_until !== undefined && new Date(preferences.muted_until) > now) ||
      (preferences.quiet_hours !== undefined &&
        isQuiet(deliveryAt, preferences.time_zone, preferences.quiet_hours))
    );
  }

  private validateNotificationRequest(request: NotificationRequest): void {
    if (!request.dedupe_key || request.dedupe_key.length > 256) {
      throw this.validation('dedupe_key must contain 1 to 256 characters.');
    }
    this.validateUuid(request.source_ref.id, 'source_ref.id');
    if (request.source_ref.version !== undefined && request.source_ref.version < 1) {
      throw this.validation('source_ref.version must be positive.');
    }
    if (request.scheduled_at) this.validateTimestamp(request.scheduled_at, 'scheduled_at');
  }

  private validatePreferences(preferences: NotificationPreferences): void {
    this.validateTimeZone(preferences.time_zone);
    if (new Set(preferences.enabled_channels).size !== preferences.enabled_channels.length) {
      throw this.validation('enabled_channels must be unique.');
    }
    if (new Set(preferences.unsubscribed_types).size !== preferences.unsubscribed_types.length) {
      throw this.validation('unsubscribed_types must be unique.');
    }
    if (preferences.muted_until) this.validateTimestamp(preferences.muted_until, 'muted_until');
    if (preferences.quiet_hours) this.validateQuietHours(preferences.quiet_hours);
  }

  private validateQuietHours(quiet: QuietHours): void {
    if (!TIME_PATTERN.test(quiet.start) || !TIME_PATTERN.test(quiet.end)) {
      throw this.validation('quiet_hours must use HH:mm values.');
    }
    if (
      quiet.days &&
      (new Set(quiet.days).size !== quiet.days.length ||
        quiet.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
    ) {
      throw this.validation('quiet_hours.days must contain unique values from 0 to 6.');
    }
  }

  private validateSourceRecord(record: ReportingSourceRecord): void {
    this.validateUuid(record.record_id, 'record_id');
    this.validateUuid(record.user_id, 'user_id');
    this.validateUuid(record.source_ref.id, 'source_ref.id');
    this.validateTimestamp(record.occurred_at, 'occurred_at');
    if (!CATEGORIES.includes(record.category)) throw this.validation('category is invalid.');
    if (record.reason_code && record.reason_code.length > 128) {
      throw this.validation('reason_code cannot exceed 128 characters.');
    }
  }

  private validateTimeZone(timeZone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    } catch {
      throw this.validation('time_zone must be a valid IANA time zone.');
    }
  }

  private validateTimestamp(value: string, field: string): void {
    if (!value || !Number.isFinite(Date.parse(value)))
      throw this.validation(`${field} must be a timestamp.`);
  }

  private validateUuid(value: string, field: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw this.validation(`${field} must be a UUID.`);
    }
  }

  private validation(message: string): ReportingError {
    return new ReportingError('VALIDATION_FAILED', message, 400);
  }
}

function defaultPreferences(): NotificationPreferences {
  return {
    time_zone: 'UTC',
    enabled_channels: ['in_app', 'email'],
    unsubscribed_types: [],
  };
}

function nextAllowedInstant(start: Date, timeZone: string, quietHours?: QuietHours): Date {
  if (!quietHours) return start;
  const candidate = new Date(start);
  candidate.setUTCSeconds(0, 0);
  if (candidate < start) candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let minute = 0; minute <= 8 * 24 * 60; minute += 1) {
    if (!isQuiet(candidate, timeZone, quietHours)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return start;
}

function isQuiet(instant: Date, timeZone: string, quiet: QuietHours): boolean {
  const parts = localParts(instant, timeZone);
  const minute = parts.hour * 60 + parts.minute;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return !quiet.days || quiet.days.includes(parts.weekday);
  if (start < end) {
    return (!quiet.days || quiet.days.includes(parts.weekday)) && minute >= start && minute < end;
  }
  if (minute >= start) return !quiet.days || quiet.days.includes(parts.weekday);
  const previousWeekday = (parts.weekday + 6) % 7;
  return minute < end && (!quiet.days || quiet.days.includes(previousWeekday));
}

function localDateAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function localParts(
  instant: Date,
  timeZone: string,
): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday),
    hour: Number(value.hour),
    minute: Number(value.minute),
  };
}

function minutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}
