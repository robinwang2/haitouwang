import type { ResourceRef } from '../applications';

export type NotificationType =
  | 'high_match'
  | 'review_required'
  | 'login_expired'
  | 'task_failed'
  | 'deadline_due'
  | 'daily_report';

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'suppressed';
export type NotificationChannel = 'in_app' | 'email';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  status: NotificationStatus;
  dedupe_key: string;
  channel: NotificationChannel;
  scheduled_at?: string;
  source_ref: ResourceRef;
  created_at: string;
  sent_at?: string;
}

export interface NotificationRequest {
  type: NotificationType;
  dedupe_key: string;
  channel: NotificationChannel;
  source_ref: ResourceRef;
  scheduled_at?: string;
  data_deleted?: boolean;
}

export interface QuietHours {
  start: string;
  end: string;
  days?: number[];
}

export interface NotificationPreferences {
  time_zone: string;
  enabled_channels: NotificationChannel[];
  unsubscribed_types: NotificationType[];
  quiet_hours?: QuietHours;
  muted_until?: string;
}

export interface NotificationDeliveryPayload {
  notification_id: string;
  notification_type: NotificationType;
  channel: NotificationChannel;
  source_ref: ResourceRef;
}

export type DailyReportCategory =
  | 'discovered'
  | 'deduplicated'
  | 'submitted'
  | 'pending_confirmation'
  | 'manual_tasks'
  | 'filtered'
  | 'exceptions';

export interface ReportingSourceRecord {
  record_id: string;
  user_id: string;
  category: DailyReportCategory;
  source_ref: ResourceRef;
  occurred_at: string;
  reason_code?: string;
}

export interface DailyReportTraceRecord {
  record_id: string;
  source_ref: ResourceRef;
  occurred_at: string;
  reason_code?: string;
}

export interface DailyReportSection {
  count: number;
  records: DailyReportTraceRecord[];
}

export interface DailyReport {
  id: string;
  user_id: string;
  local_date: string;
  time_zone: string;
  generated_at: string;
  sections: Record<DailyReportCategory, DailyReportSection>;
  source_record_count: number;
}

export interface ReportingServiceOptions {
  clock?: { now(): Date };
  id_factory?: () => string;
}
