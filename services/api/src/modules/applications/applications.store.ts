import { Injectable } from '@nestjs/common';

import type {
  ApplicationIdempotencyRecord,
  ApplicationReceiptRecord,
  ApplicationsStore,
} from './applications-store.interface';
import type {
  Application,
  ApplicationAuditEvent,
  ManualApplicationTask,
} from './applications.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface StoredAuditEvent {
  user_id: string;
  event: ApplicationAuditEvent;
}

@Injectable()
export class InMemoryApplicationsStore implements ApplicationsStore {
  private readonly applications = new Map<string, Application>();
  private readonly manualTasks = new Map<string, ManualApplicationTask>();
  private readonly idempotency = new Map<string, ApplicationIdempotencyRecord>();
  private readonly receipts = new Map<string, ApplicationReceiptRecord>();
  private readonly audit: StoredAuditEvent[] = [];

  async withTransaction<T>(operation: (store: ApplicationsStore) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async getApplication(userId: string, applicationId: string): Promise<Application | undefined> {
    const application = this.applications.get(applicationId);
    return application && application.user_id === userId ? clone(application) : undefined;
  }

  async saveApplication(userId: string, application: Application): Promise<void> {
    if (application.user_id !== userId) {
      throw new Error('Applications store tenant mismatch.');
    }
    for (const existing of this.applications.values()) {
      if (
        existing.id !== application.id &&
        existing.user_id === userId &&
        existing.submission_idempotency_key === application.submission_idempotency_key
      ) {
        throw new Error(
          `submission_idempotency_key already used by another application: ${application.submission_idempotency_key}`,
        );
      }
    }
    this.applications.set(application.id, clone(application));
  }

  async listApplications(userId: string): Promise<Application[]> {
    return [...this.applications.values()]
      .filter((application) => application.user_id === userId)
      .map(clone);
  }

  async findApplicationIdBySubmissionKey(
    userId: string,
    submissionKey: string,
  ): Promise<string | undefined> {
    for (const application of this.applications.values()) {
      if (
        application.user_id === userId &&
        application.submission_idempotency_key === submissionKey
      ) {
        return application.id;
      }
    }
    return undefined;
  }

  async saveManualTask(userId: string, task: ManualApplicationTask): Promise<void> {
    if (task.user_id !== userId) {
      throw new Error('Applications store tenant mismatch.');
    }
    this.manualTasks.set(task.id, clone(task));
  }

  async listManualTasks(userId: string, applicationId?: string): Promise<ManualApplicationTask[]> {
    return [...this.manualTasks.values()]
      .filter(
        (task) => task.user_id === userId && (!applicationId || task.resource.id === applicationId),
      )
      .map(clone);
  }

  async getIdempotencyRecord(
    userId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<ApplicationIdempotencyRecord | undefined> {
    const record = this.idempotency.get(this.idempotencyMapKey(userId, operation, idempotencyKey));
    return record ? clone(record) : undefined;
  }

  async saveIdempotencyRecord(
    userId: string,
    operation: string,
    idempotencyKey: string,
    record: ApplicationIdempotencyRecord,
  ): Promise<void> {
    this.idempotency.set(this.idempotencyMapKey(userId, operation, idempotencyKey), clone(record));
  }

  async getReceipt(
    userId: string,
    receiptKey: string,
  ): Promise<ApplicationReceiptRecord | undefined> {
    const record = this.receipts.get(this.receiptMapKey(userId, receiptKey));
    return record ? clone(record) : undefined;
  }

  async saveReceipt(
    userId: string,
    receiptKey: string,
    record: ApplicationReceiptRecord,
  ): Promise<void> {
    const key = this.receiptMapKey(userId, receiptKey);
    if (this.receipts.has(key)) {
      throw new Error(`receipt key already recorded: ${receiptKey}`);
    }
    for (const [existingKey, existing] of this.receipts.entries()) {
      if (existingKey.startsWith(`${userId}:`) && existing.receipt_id === record.receipt_id) {
        throw new Error(`receipt_id already recorded: ${record.receipt_id}`);
      }
    }
    this.receipts.set(key, clone(record));
  }

  async appendAuditEvent(userId: string, event: ApplicationAuditEvent): Promise<void> {
    this.audit.push({ user_id: userId, event: clone(event) });
  }

  async listAuditEvents(userId: string): Promise<ApplicationAuditEvent[]> {
    return this.audit
      .filter((stored) => stored.user_id === userId)
      .map((stored) => clone(stored.event));
  }

  private idempotencyMapKey(userId: string, operation: string, idempotencyKey: string): string {
    return `${userId}:${operation}:${idempotencyKey}`;
  }

  private receiptMapKey(userId: string, receiptKey: string): string {
    return `${userId}:${receiptKey}`;
  }
}
