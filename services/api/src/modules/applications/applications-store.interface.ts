import type {
  Application,
  ApplicationAuditEvent,
  ManualApplicationTask,
  RecordedApplicationReceipt,
} from './applications.types';

export const APPLICATIONS_STORE = Symbol('APPLICATIONS_STORE');

export interface ApplicationIdempotencyRecord {
  request_hash: string;
  response: unknown;
  audit_event_id: string;
}

export interface ApplicationReceiptRecord {
  receipt_id: string;
  request_hash: string;
  response: RecordedApplicationReceipt;
}

/**
 * Persistence boundary for the Application aggregate (applications, manual tasks,
 * mutation idempotency records, agent receipt idempotency records, and the audit trail).
 * Every operation is tenant-scoped by user_id. The service keeps state-machine and evidence
 * decisions while all aggregate state is read and written through this boundary.
 *
 * submissionKeys (the service's `${userId}:${submission_idempotency_key}` -> application id
 * index) has no dedicated method here: the submission key already lives on Application itself,
 * so findApplicationIdBySubmissionKey queries applications directly and the uniqueness
 * invariant is enforced by a SQL UNIQUE(user_id, submission_idempotency_key) constraint.
 */
export interface ApplicationsStore {
  withTransaction<T>(operation: (store: ApplicationsStore) => Promise<T>): Promise<T>;

  getApplication(userId: string, applicationId: string): Promise<Application | undefined>;
  saveApplication(userId: string, application: Application): Promise<void>;
  listApplications(userId: string): Promise<Application[]>;
  findApplicationIdBySubmissionKey(
    userId: string,
    submissionKey: string,
  ): Promise<string | undefined>;

  saveManualTask(userId: string, task: ManualApplicationTask): Promise<void>;
  listManualTasks(userId: string, applicationId?: string): Promise<ManualApplicationTask[]>;

  getIdempotencyRecord(
    userId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<ApplicationIdempotencyRecord | undefined>;
  saveIdempotencyRecord(
    userId: string,
    operation: string,
    idempotencyKey: string,
    record: ApplicationIdempotencyRecord,
  ): Promise<void>;

  getReceipt(userId: string, receiptKey: string): Promise<ApplicationReceiptRecord | undefined>;
  saveReceipt(userId: string, receiptKey: string, record: ApplicationReceiptRecord): Promise<void>;

  appendAuditEvent(userId: string, event: ApplicationAuditEvent): Promise<void>;
  listAuditEvents(userId: string): Promise<ApplicationAuditEvent[]>;
}
