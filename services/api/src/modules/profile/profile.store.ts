import { Injectable } from '@nestjs/common';

import type { IdempotencyRecord, ProfileStore } from './profile-store.interface';
import type { AuditEvent, Fact, FileMetadata, Goal, VersionRecord } from './profile.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

@Injectable()
export class InMemoryProfileStore implements ProfileStore {
  readonly goals = new Map<string, Goal>();
  readonly facts = new Map<string, Fact>();
  readonly files = new Map<string, FileMetadata>();
  readonly goalVersions = new Map<string, VersionRecord<Goal>[]>();
  readonly factVersions = new Map<string, VersionRecord<Fact>[]>();
  readonly fileVersions = new Map<string, VersionRecord<FileMetadata>[]>();
  readonly auditEvents: AuditEvent[] = [];
  readonly idempotency = new Map<string, IdempotencyRecord>();

  async withTransaction<T>(operation: (store: ProfileStore) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async getGoal(userId: string, goalId: string): Promise<Goal | undefined> {
    return this.owned(this.goals.get(goalId), userId);
  }

  async listGoals(userId: string, includeArchived = false): Promise<Goal[]> {
    return [...this.goals.values()]
      .filter((goal) => goal.user_id === userId && (includeArchived || goal.status !== 'archived'))
      .sort(this.byCreatedAt)
      .map(clone);
  }

  async saveGoal(userId: string, goal: Goal): Promise<void> {
    this.assertUser(userId, goal.user_id);
    this.goals.set(goal.id, clone(goal));
  }

  async deleteGoal(userId: string, goalId: string): Promise<boolean> {
    if (!(await this.getGoal(userId, goalId))) return false;
    return this.goals.delete(goalId);
  }

  async getFact(userId: string, factId: string): Promise<Fact | undefined> {
    return this.owned(this.facts.get(factId), userId);
  }

  async listFacts(userId: string, includeDeleted = false): Promise<Fact[]> {
    return [...this.facts.values()]
      .filter((fact) => fact.user_id === userId && (includeDeleted || fact.status !== 'deleted'))
      .sort(this.byCreatedAt)
      .map(clone);
  }

  async saveFact(userId: string, fact: Fact): Promise<void> {
    this.assertUser(userId, fact.user_id);
    this.facts.set(fact.id, clone(fact));
  }

  async deleteFact(userId: string, factId: string): Promise<boolean> {
    if (!(await this.getFact(userId, factId))) return false;
    return this.facts.delete(factId);
  }

  async getFile(userId: string, fileId: string): Promise<FileMetadata | undefined> {
    return this.owned(this.files.get(fileId), userId);
  }

  async listFiles(userId: string): Promise<FileMetadata[]> {
    return [...this.files.values()]
      .filter((file) => file.user_id === userId)
      .sort(this.byCreatedAt)
      .map(clone);
  }

  async saveFile(userId: string, file: FileMetadata): Promise<void> {
    this.assertUser(userId, file.user_id);
    this.files.set(file.id, clone(file));
  }

  async deleteFile(userId: string, fileId: string): Promise<boolean> {
    if (!(await this.getFile(userId, fileId))) return false;
    return this.files.delete(fileId);
  }

  async listGoalVersions(userId: string, goalId: string): Promise<VersionRecord<Goal>[]> {
    return this.versions(this.goalVersions, userId, goalId);
  }

  async appendGoalVersion(userId: string, version: VersionRecord<Goal>): Promise<void> {
    this.appendVersion(this.goalVersions, userId, version);
  }

  async deleteGoalVersions(userId: string, goalId: string): Promise<void> {
    if (this.belongsTo(this.goalVersions.get(goalId), userId)) this.goalVersions.delete(goalId);
  }

  async listFactVersions(userId: string, factId: string): Promise<VersionRecord<Fact>[]> {
    return this.versions(this.factVersions, userId, factId);
  }

  async appendFactVersion(userId: string, version: VersionRecord<Fact>): Promise<void> {
    this.appendVersion(this.factVersions, userId, version);
  }

  async replaceFactVersions(userId: string, versions: VersionRecord<Fact>[]): Promise<void> {
    if (versions.length === 0) return;
    versions.forEach((version) => this.assertUser(userId, version.snapshot.user_id));
    this.factVersions.set(versions[0].resource_id, clone(versions));
  }

  async deleteFactVersions(userId: string, factId: string): Promise<void> {
    if (this.belongsTo(this.factVersions.get(factId), userId)) this.factVersions.delete(factId);
  }

  async listFileVersions(userId: string, fileId: string): Promise<VersionRecord<FileMetadata>[]> {
    return this.versions(this.fileVersions, userId, fileId);
  }

  async appendFileVersion(userId: string, version: VersionRecord<FileMetadata>): Promise<void> {
    this.appendVersion(this.fileVersions, userId, version);
  }

  async deleteFileVersions(userId: string, fileId: string): Promise<void> {
    if (this.belongsTo(this.fileVersions.get(fileId), userId)) this.fileVersions.delete(fileId);
  }

  async listAuditEvents(userId: string): Promise<AuditEvent[]> {
    return this.auditEvents.filter((event) => event.tenant_id === userId).map(clone);
  }

  async appendAuditEvent(userId: string, event: AuditEvent): Promise<void> {
    this.assertUser(userId, event.tenant_id);
    this.auditEvents.push(clone(event));
  }

  async getIdempotency(
    userId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    const record = this.idempotency.get(this.idempotencyKey(userId, operation, idempotencyKey));
    return record && clone(record);
  }

  async saveIdempotency(
    userId: string,
    operation: string,
    idempotencyKey: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    this.idempotency.set(this.idempotencyKey(userId, operation, idempotencyKey), clone(record));
  }

  async deleteIdempotencyForResource(userId: string, resourceId: string): Promise<void> {
    const prefix = `${userId}:`;
    for (const [key, record] of this.idempotency) {
      if (key.startsWith(prefix) && record.resource_id === resourceId) this.idempotency.delete(key);
    }
  }

  async deleteIdempotencyForUser(userId: string): Promise<void> {
    const prefix = `${userId}:`;
    for (const key of this.idempotency.keys()) {
      if (key.startsWith(prefix)) this.idempotency.delete(key);
    }
  }

  async deleteUserData(userId: string): Promise<{ goals: number; facts: number; files: number }> {
    const goalIds = this.ownedIds(this.goals, userId);
    const factIds = this.ownedIds(this.facts, userId);
    const fileIds = this.ownedIds(this.files, userId);
    goalIds.forEach((id) => {
      this.goals.delete(id);
      this.goalVersions.delete(id);
    });
    factIds.forEach((id) => {
      this.facts.delete(id);
      this.factVersions.delete(id);
    });
    fileIds.forEach((id) => {
      this.files.delete(id);
      this.fileVersions.delete(id);
    });
    return { goals: goalIds.length, facts: factIds.length, files: fileIds.length };
  }

  private owned<T extends { user_id: string }>(
    value: T | undefined,
    userId: string,
  ): T | undefined {
    return value?.user_id === userId ? clone(value) : undefined;
  }

  private versions<T extends { user_id: string }>(
    versions: Map<string, VersionRecord<T>[]>,
    userId: string,
    resourceId: string,
  ): VersionRecord<T>[] {
    const history = versions.get(resourceId);
    return this.belongsTo(history, userId) ? clone(history ?? []) : [];
  }

  private appendVersion<T extends { user_id: string }>(
    versions: Map<string, VersionRecord<T>[]>,
    userId: string,
    version: VersionRecord<T>,
  ): void {
    this.assertUser(userId, version.snapshot.user_id);
    const history = versions.get(version.resource_id) ?? [];
    history.push(clone(version));
    versions.set(version.resource_id, history);
  }

  private belongsTo<T extends { user_id: string }>(
    versions: VersionRecord<T>[] | undefined,
    userId: string,
  ): boolean {
    return Boolean(versions?.every((version) => version.snapshot.user_id === userId));
  }

  private ownedIds<T extends { user_id: string }>(
    records: Map<string, T>,
    userId: string,
  ): string[] {
    return [...records.entries()]
      .filter(([, resource]) => resource.user_id === userId)
      .map(([id]) => id);
  }

  private idempotencyKey(userId: string, operation: string, key: string): string {
    return `${userId}:${operation}:${key}`;
  }

  private assertUser(expected: string, actual: string): void {
    if (expected !== actual) throw new Error('Profile store tenant mismatch.');
  }

  private byCreatedAt<T extends { id: string; created_at: string }>(left: T, right: T): number {
    return `${left.created_at}:${left.id}`.localeCompare(`${right.created_at}:${right.id}`);
  }
}
