import type { AuditEvent, Fact, FileMetadata, Goal, VersionRecord } from './profile.types';

export const PROFILE_STORE = Symbol('PROFILE_STORE');

export interface IdempotencyRecord {
  request_hash: string;
  response: unknown;
  audit_event_id: string;
  resource_id: string;
}

/**
 * Persistence boundary for profile data. Every operation is tenant-scoped, including
 * version history, audit events, and idempotency records.
 */
export interface ProfileStore {
  withTransaction<T>(operation: (store: ProfileStore) => Promise<T>): Promise<T>;

  getGoal(userId: string, goalId: string): Promise<Goal | undefined>;
  listGoals(userId: string, includeArchived?: boolean): Promise<Goal[]>;
  saveGoal(userId: string, goal: Goal): Promise<void>;
  deleteGoal(userId: string, goalId: string): Promise<boolean>;

  getFact(userId: string, factId: string): Promise<Fact | undefined>;
  listFacts(userId: string, includeDeleted?: boolean): Promise<Fact[]>;
  saveFact(userId: string, fact: Fact): Promise<void>;
  deleteFact(userId: string, factId: string): Promise<boolean>;

  getFile(userId: string, fileId: string): Promise<FileMetadata | undefined>;
  listFiles(userId: string): Promise<FileMetadata[]>;
  saveFile(userId: string, file: FileMetadata): Promise<void>;
  deleteFile(userId: string, fileId: string): Promise<boolean>;

  listGoalVersions(userId: string, goalId: string): Promise<VersionRecord<Goal>[]>;
  appendGoalVersion(userId: string, version: VersionRecord<Goal>): Promise<void>;
  deleteGoalVersions(userId: string, goalId: string): Promise<void>;

  listFactVersions(userId: string, factId: string): Promise<VersionRecord<Fact>[]>;
  appendFactVersion(userId: string, version: VersionRecord<Fact>): Promise<void>;
  replaceFactVersions(userId: string, versions: VersionRecord<Fact>[]): Promise<void>;
  deleteFactVersions(userId: string, factId: string): Promise<void>;

  listFileVersions(userId: string, fileId: string): Promise<VersionRecord<FileMetadata>[]>;
  appendFileVersion(userId: string, version: VersionRecord<FileMetadata>): Promise<void>;
  deleteFileVersions(userId: string, fileId: string): Promise<void>;

  listAuditEvents(userId: string): Promise<AuditEvent[]>;
  appendAuditEvent(userId: string, event: AuditEvent): Promise<void>;

  getIdempotency(
    userId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(
    userId: string,
    operation: string,
    idempotencyKey: string,
    record: IdempotencyRecord,
  ): Promise<void>;
  deleteIdempotencyForResource(userId: string, resourceId: string): Promise<void>;
  deleteIdempotencyForUser(userId: string): Promise<void>;

  deleteUserData(userId: string): Promise<{ goals: number; facts: number; files: number }>;
}
