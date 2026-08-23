import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ProfileError } from './profile.errors';
import { PROFILE_STORE } from './profile-store.interface';
import type { ProfileStore } from './profile-store.interface';
import type {
  AuditEvent,
  CreateFactInput,
  CreateFileMetadataInput,
  CreateGoalInput,
  Fact,
  FactListFilter,
  FactStatus,
  FileMetadata,
  FileScanStatus,
  Goal,
  MutationContext,
  ProfileExport,
  UpdateFactInput,
  UpdateGoalInput,
  VersionRecord,
} from './profile.types';

const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{16,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type ResourceType = AuditEvent['resource']['type'];

interface AuditChange {
  resourceType: ResourceType;
  resourceId: string;
  action: string;
  changedFields: string[];
  beforeStatus?: string;
  afterStatus?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

@Injectable()
export class ProfileService {
  constructor(
    @Inject(PROFILE_STORE)
    private readonly store: ProfileStore,
  ) {}

  async createGoal(userId: string, input: CreateGoalInput, context: MutationContext): Promise<Goal> {
    this.validateUserAndContext(userId, context);
    this.validateGoalInput(input);

    return this.mutate(userId, 'createGoal', input, context, async (store) => {
      const now = this.now();
      const goal: Goal = {
        ...clone(input),
        id: randomUUID(),
        user_id: userId,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      await store.saveGoal(userId, goal);
      await store.appendGoalVersion(userId, {
        resource_id: goal.id,
        version: goal.version,
        recorded_at: now,
        snapshot: clone(goal),
      });
      return {
        result: goal,
        audit: {
          resourceType: 'goal',
          resourceId: goal.id,
          action: 'goal.created',
          changedFields: [
            'name',
            'title_keywords',
            'locations',
            'employment_types',
            'salary',
            'work_authorization_rule',
            'locale',
            'status',
          ].filter((field) => field in input),
          afterStatus: goal.status,
        },
      };
    });
  }

  async getGoal(userId: string, goalId: string): Promise<Goal> {
    return this.requireOwned(userId, goalId, 'goal', () => this.store.getGoal(userId, goalId));
  }

  async listGoals(userId: string, includeArchived = false): Promise<Goal[]> {
    return this.listGoalsFrom(this.store, userId, includeArchived);
  }

  async updateGoal(
    userId: string,
    goalId: string,
    expectedVersion: number,
    input: UpdateGoalInput,
    context: MutationContext,
  ): Promise<Goal> {
    this.validateUserAndContext(userId, context);
    this.validateNonEmptyUpdate(input);
    this.validateGoalPatch(input);

    return this.mutate(userId, 'updateGoal', { goalId, expectedVersion, input }, context, async (store) => {
      const current = await this.requireOwned(userId, goalId, 'goal', () => store.getGoal(userId, goalId));
      this.assertVersion(current.version, expectedVersion);
      const now = this.now();
      const updated: Goal = {
        ...clone(current),
        ...clone(input),
        id: current.id,
        user_id: current.user_id,
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: now,
      };
      await store.saveGoal(userId, updated);
      await store.appendGoalVersion(userId, {
        resource_id: updated.id,
        version: updated.version,
        recorded_at: now,
        snapshot: clone(updated),
      });
      return {
        result: updated,
        audit: {
          resourceType: 'goal',
          resourceId: goalId,
          action: 'goal.updated',
          changedFields: Object.keys(input),
          beforeStatus: current.status,
          afterStatus: updated.status,
        },
      };
    });
  }

  async deleteGoal(
    userId: string,
    goalId: string,
    expectedVersion: number,
    context: MutationContext,
  ): Promise<void> {
    this.validateUserAndContext(userId, context);
    await this.mutate(userId, 'deleteGoal', { goalId, expectedVersion }, context, async (store) => {
      const current = await this.requireOwned(userId, goalId, 'goal', () => store.getGoal(userId, goalId));
      this.assertVersion(current.version, expectedVersion);
      await store.deleteGoal(userId, goalId);
      await store.deleteGoalVersions(userId, goalId);
      await store.deleteIdempotencyForResource(userId, goalId);
      return {
        result: undefined,
        audit: {
          resourceType: 'goal',
          resourceId: goalId,
          action: 'goal.deleted',
          changedFields: ['deleted'],
          beforeStatus: current.status,
          afterStatus: 'deleted',
        },
      };
    });
  }

  async getGoalVersions(userId: string, goalId: string): Promise<VersionRecord<Goal>[]> {
    await this.requireOwned(userId, goalId, 'goal', () => this.store.getGoal(userId, goalId));
    return this.store.listGoalVersions(userId, goalId);
  }

  async createFact(userId: string, input: CreateFactInput, context: MutationContext): Promise<Fact> {
    this.validateUserAndContext(userId, context);
    await this.validateFactInput(this.store, userId, input);

    return this.mutate(userId, 'createFact', input, context, async (store) => {
      const now = this.now();
      const status: FactStatus =
        input.scope.use === 'prohibited'
          ? 'prohibited'
          : input.user_confirmed
            ? 'active'
            : 'pending_confirmation';
      const fact: Fact = {
        id: randomUUID(),
        user_id: userId,
        kind: input.kind,
        value: clone(input.value),
        scope: clone(input.scope),
        status,
        source: clone(input.source),
        version: 1,
        created_at: now,
        updated_at: now,
        ...(input.valid_from ? { valid_from: input.valid_from } : {}),
        ...(input.valid_until ? { valid_until: input.valid_until } : {}),
        ...(status === 'active' ? { confirmed_at: now } : {}),
      };
      await store.saveFact(userId, fact);
      await store.appendFactVersion(userId, {
        resource_id: fact.id,
        version: fact.version,
        recorded_at: now,
        snapshot: clone(fact),
      });
      return {
        result: fact,
        audit: {
          resourceType: 'fact',
          resourceId: fact.id,
          action: 'profile.fact.created',
          changedFields: [
            'kind',
            'value',
            'scope',
            'source',
            'valid_from',
            'valid_until',
            'status',
          ].filter((field) => field in input || field === 'status'),
          afterStatus: fact.status,
        },
      };
    });
  }

  async getFact(userId: string, factId: string): Promise<Fact> {
    return this.requireOwned(userId, factId, 'fact', () => this.store.getFact(userId, factId));
  }

  async listFacts(userId: string, filter: FactListFilter = {}): Promise<Fact[]> {
    return this.listFactsFrom(this.store, userId, filter);
  }

  async updateFact(
    userId: string,
    factId: string,
    expectedVersion: number,
    input: UpdateFactInput,
    context: MutationContext,
  ): Promise<Fact> {
    this.validateUserAndContext(userId, context);
    this.validateNonEmptyUpdate(input);
    this.rejectUnknownKeys(
      input,
      new Set(['value', 'scope', 'source', 'valid_from', 'valid_until']),
      'fact update',
    );

    return this.mutate(userId, 'updateFact', { factId, expectedVersion, input }, context, async (store) => {
      const current = await this.requireOwned(userId, factId, 'fact', () => store.getFact(userId, factId));
      this.assertVersion(current.version, expectedVersion);
      if (
        current.status === 'deleted' ||
        current.status === 'rejected' ||
        current.status === 'revoked' ||
        current.status === 'prohibited'
      ) {
        throw this.invalidTransition(current.status, 'pending_confirmation');
      }
      const merged = { ...clone(current), ...clone(input) };
      await this.validateFactInput(store, userId, {
        kind: merged.kind,
        value: merged.value,
        scope: merged.scope,
        source: merged.source,
        valid_from: merged.valid_from,
        valid_until: merged.valid_until,
      });
      const now = this.now();
      const status: FactStatus =
        merged.scope.use === 'prohibited' ? 'prohibited' : 'pending_confirmation';
      const updated: Fact = {
        ...merged,
        id: current.id,
        user_id: current.user_id,
        status,
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: now,
      };
      delete updated.confirmed_at;
      await store.saveFact(userId, updated);
      await store.appendFactVersion(userId, {
        resource_id: updated.id,
        version: updated.version,
        recorded_at: now,
        snapshot: clone(updated),
      });
      return {
        result: updated,
        audit: {
          resourceType: 'fact',
          resourceId: factId,
          action: 'profile.fact.updated',
          changedFields: [...Object.keys(input), 'status'],
          beforeStatus: current.status,
          afterStatus: updated.status,
        },
      };
    });
  }

  async confirmFact(
    userId: string,
    factId: string,
    expectedVersion: number,
    context: MutationContext,
  ): Promise<Fact> {
    return this.transitionFact(
      userId,
      factId,
      expectedVersion,
      ['pending_confirmation', 'expired'],
      'active',
      'profile.fact.confirmed',
      context,
      true,
    );
  }

  async rejectFact(
    userId: string,
    factId: string,
    expectedVersion: number,
    context: MutationContext,
  ): Promise<Fact> {
    return this.transitionFact(
      userId,
      factId,
      expectedVersion,
      ['pending_confirmation'],
      'rejected',
      'profile.fact.rejected',
      context,
    );
  }

  async expireFact(
    userId: string,
    factId: string,
    expectedVersion: number,
    context: MutationContext,
  ): Promise<Fact> {
    return this.transitionFact(
      userId,
      factId,
      expectedVersion,
      ['active'],
      'expired',
      'profile.fact.expired',
      context,
    );
  }

  async revokeFact(
    userId: string,
    factId: string,
    expectedVersion: number,
    context: MutationContext,
  ): Promise<Fact> {
    return this.transitionFact(
      userId,
      factId,
      expectedVersion,
      ['active'],
      'revoked',
      'profile.fact.revoked',
      context,
    );
  }

  async deleteFact(
    userId: string,
    factId: string,
    expectedVersion: number,
    context: MutationContext,
  ): Promise<Fact> {
    this.validateUserAndContext(userId, context);
    return this.mutate(userId, 'deleteFact', { factId, expectedVersion }, context, async (store) => {
      const current = await this.requireOwned(userId, factId, 'fact', () => store.getFact(userId, factId));
      this.assertVersion(current.version, expectedVersion);
      if (current.status === 'deleted') {
        throw this.invalidTransition('deleted', 'deleted');
      }
      const now = this.now();
      const deleted: Fact = {
        id: current.id,
        user_id: current.user_id,
        kind: current.kind,
        value: { deleted: true },
        scope: { use: 'prohibited' },
        status: 'deleted',
        source: { type: 'system_rule', reference: 'deleted' },
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: now,
      };
      await store.saveFact(userId, deleted);
      await store.replaceFactVersions(userId, [
        {
          resource_id: factId,
          version: deleted.version,
          recorded_at: now,
          snapshot: clone(deleted),
        },
      ]);
      await store.deleteIdempotencyForResource(userId, factId);
      return {
        result: deleted,
        audit: {
          resourceType: 'fact',
          resourceId: factId,
          action: 'profile.fact.deleted',
          changedFields: [
            'value',
            'scope',
            'source',
            'valid_from',
            'valid_until',
            'confirmed_at',
            'status',
          ],
          beforeStatus: current.status,
          afterStatus: 'deleted',
        },
      };
    });
  }

  async getFactVersions(userId: string, factId: string): Promise<VersionRecord<Fact>[]> {
    await this.requireOwned(userId, factId, 'fact', () => this.store.getFact(userId, factId));
    return this.store.listFactVersions(userId, factId);
  }

  async isFactUsable(userId: string, factId: string, goalId?: string): Promise<boolean> {
    const fact = await this.requireOwned(userId, factId, 'fact', () => this.store.getFact(userId, factId));
    const resolvedGoal = await this.resolveUsableGoal(userId, goalId);
    return this.evaluateFactUsable(fact, resolvedGoal, goalId);
  }

  async listUsableFacts(userId: string, goalId?: string): Promise<Fact[]> {
    const facts = await this.listFacts(userId);
    const resolvedGoal = await this.resolveUsableGoal(userId, goalId);
    return facts.filter((fact) => this.evaluateFactUsable(fact, resolvedGoal, goalId));
  }

  async getUsableWorkAuthorizationFacts(userId: string, goalId: string): Promise<Fact[]> {
    const facts = await this.listUsableFacts(userId, goalId);
    return facts.filter((fact) => fact.kind === 'work_authorization');
  }

  async createFileMetadata(
    userId: string,
    input: CreateFileMetadataInput,
    context: MutationContext,
  ): Promise<FileMetadata> {
    this.validateUserAndContext(userId, context);
    this.validateFileInput(input);
    return this.mutate(userId, 'createFileMetadata', input, context, async (store) => {
      const now = this.now();
      const file: FileMetadata = {
        ...clone(input),
        id: randomUUID(),
        user_id: userId,
        scan_status: input.scan_status ?? 'pending',
        version: 1,
        created_at: now,
      };
      await store.saveFile(userId, file);
      await store.appendFileVersion(userId, {
        resource_id: file.id,
        version: file.version,
        recorded_at: now,
        snapshot: clone(file),
      });
      return {
        result: file,
        audit: {
          resourceType: 'file',
          resourceId: file.id,
          action: 'profile.file.created',
          changedFields: [
            'purpose',
            'display_name',
            'media_type',
            'byte_size',
            'sha256',
            'scan_status',
          ],
          afterStatus: file.scan_status,
        },
      };
    });
  }

  async getFileMetadata(userId: string, fileId: string): Promise<FileMetadata> {
    return this.requireOwned(userId, fileId, 'file', () => this.store.getFile(userId, fileId));
  }

  async listFileMetadata(userId: string): Promise<FileMetadata[]> {
    return this.listFileMetadataFrom(this.store, userId);
  }

  async updateFileScanStatus(
    userId: string,
    fileId: string,
    expectedVersion: number,
    scanStatus: FileScanStatus,
    context: MutationContext,
  ): Promise<FileMetadata> {
    this.validateUserAndContext(userId, context);
    if (!['pending', 'clean', 'quarantined', 'infected', 'failed'].includes(scanStatus)) {
      throw this.validation('scan_status is invalid.');
    }
    return this.mutate(
      userId,
      'updateFileScanStatus',
      { fileId, expectedVersion, scanStatus },
      context,
      async (store) => {
        const current = await this.requireOwned(userId, fileId, 'file', () => store.getFile(userId, fileId));
        this.assertVersion(current.version, expectedVersion);
        const now = this.now();
        const updated = {
          ...clone(current),
          scan_status: scanStatus,
          version: current.version + 1,
        };
        await store.saveFile(userId, updated);
        await store.appendFileVersion(userId, {
          resource_id: updated.id,
          version: updated.version,
          recorded_at: now,
          snapshot: clone(updated),
        });
        return {
          result: updated,
          audit: {
            resourceType: 'file',
            resourceId: fileId,
            action: 'profile.file.scan_status_changed',
            changedFields: ['scan_status'],
            beforeStatus: current.scan_status,
            afterStatus: scanStatus,
          },
        };
      },
    );
  }

  async listUsableResumeFiles(userId: string): Promise<FileMetadata[]> {
    const files = await this.listFileMetadata(userId);
    return files.filter(
      (file) =>
        (file.purpose === 'resume_source' || file.purpose === 'resume_output') &&
        file.scan_status === 'clean',
    );
  }

  async getFileVersions(userId: string, fileId: string): Promise<VersionRecord<FileMetadata>[]> {
    await this.requireOwned(userId, fileId, 'file', () => this.store.getFile(userId, fileId));
    return this.store.listFileVersions(userId, fileId);
  }

  async deleteFileMetadata(
    userId: string,
    fileId: string,
    expectedVersion: number,
    context: MutationContext,
  ): Promise<void> {
    this.validateUserAndContext(userId, context);
    await this.mutate(userId, 'deleteFileMetadata', { fileId, expectedVersion }, context, async (store) => {
      const current = await this.requireOwned(userId, fileId, 'file', () => store.getFile(userId, fileId));
      this.assertVersion(current.version, expectedVersion);
      await store.deleteFile(userId, fileId);
      await store.deleteFileVersions(userId, fileId);
      await store.deleteIdempotencyForResource(userId, fileId);
      return {
        result: undefined,
        audit: {
          resourceType: 'file',
          resourceId: fileId,
          action: 'profile.file.deleted',
          changedFields: ['deleted'],
          beforeStatus: current.scan_status,
          afterStatus: 'deleted',
        },
      };
    });
  }

  async listAuditEvents(userId: string): Promise<AuditEvent[]> {
    return this.listAuditEventsFrom(this.store, userId);
  }

  async exportProfile(userId: string, context: MutationContext): Promise<ProfileExport> {
    this.validateUserAndContext(userId, context);
    return this.mutate(userId, 'exportProfile', { userId }, context, async (store) => ({
      result: {
        schema_version: '1.0.0',
        exported_at: this.now(),
        user_id: userId,
        goals: await this.listGoalsFrom(store, userId, true),
        facts: await this.listFactsFrom(store, userId, { include_deleted: true }),
        files: await this.listFileMetadataFrom(store, userId),
        audit: await this.listAuditEventsFrom(store, userId),
      },
      audit: {
        resourceType: 'user',
        resourceId: userId,
        action: 'profile.exported',
        changedFields: [],
      },
    }));
  }

  async deleteUserProfile(
    userId: string,
    context: MutationContext,
  ): Promise<{ goals: number; facts: number; files: number }> {
    this.validateUserAndContext(userId, context);
    return this.mutate(userId, 'deleteUserProfile', { userId }, context, async (store) => {
      const counts = await store.deleteUserData(userId);
      await store.deleteIdempotencyForUser(userId);
      return {
        result: counts,
        audit: {
          resourceType: 'user',
          resourceId: userId,
          action: 'profile.deleted',
          changedFields: ['goals', 'facts', 'files'],
          afterStatus: 'deleted',
        },
      };
    });
  }

  private async transitionFact(
    userId: string,
    factId: string,
    expectedVersion: number,
    allowedFrom: FactStatus[],
    target: FactStatus,
    action: string,
    context: MutationContext,
    confirm = false,
  ): Promise<Fact> {
    this.validateUserAndContext(userId, context);
    return this.mutate(userId, action, { factId, expectedVersion, target }, context, async (store) => {
      const current = await this.requireOwned(userId, factId, 'fact', () => store.getFact(userId, factId));
      this.assertVersion(current.version, expectedVersion);
      if (!allowedFrom.includes(current.status)) {
        throw this.invalidTransition(current.status, target);
      }
      if (target === 'active' && current.scope.use === 'prohibited') {
        throw this.invalidTransition(current.status, 'prohibited');
      }
      const now = this.now();
      const updated: Fact = {
        ...clone(current),
        status: target,
        version: current.version + 1,
        updated_at: now,
        ...(confirm ? { confirmed_at: now } : {}),
      };
      await store.saveFact(userId, updated);
      await store.appendFactVersion(userId, {
        resource_id: updated.id,
        version: updated.version,
        recorded_at: now,
        snapshot: clone(updated),
      });
      return {
        result: updated,
        audit: {
          resourceType: 'fact',
          resourceId: factId,
          action,
          changedFields: confirm ? ['status', 'confirmed_at'] : ['status'],
          beforeStatus: current.status,
          afterStatus: target,
        },
      };
    });
  }

  private async resolveUsableGoal(userId: string, goalId?: string): Promise<Goal | undefined> {
    if (!goalId) return undefined;
    const goal = await this.store.getGoal(userId, goalId);
    return goal && goal.status !== 'archived' ? goal : undefined;
  }

  private evaluateFactUsable(fact: Fact, resolvedGoal: Goal | undefined, goalId?: string): boolean {
    if (fact.status !== 'active' || !fact.confirmed_at) {
      return false;
    }
    const now = Date.now();
    if (
      (fact.valid_from && Date.parse(fact.valid_from) > now) ||
      (fact.valid_until && Date.parse(fact.valid_until) <= now)
    ) {
      return false;
    }
    if (fact.scope.use === 'manual_only' || fact.scope.use === 'prohibited') {
      return false;
    }
    if (goalId && !resolvedGoal) {
      return false;
    }
    if (fact.scope.use === 'all_goals') {
      return true;
    }
    return Boolean(goalId && fact.scope.goal_ids?.includes(goalId));
  }

  private async mutate<T>(
    userId: string,
    operation: string,
    request: unknown,
    context: MutationContext,
    change: (store: ProfileStore) => Promise<{ result: T; audit: AuditChange }>,
  ): Promise<T> {
    const hash = requestHash(request);
    return this.store.withTransaction(async (store) => {
      const prior = await store.getIdempotency(userId, operation, context.idempotency_key);
      if (prior) {
        if (prior.request_hash !== hash) {
          throw new ProfileError(
            'IDEMPOTENCY_KEY_REUSED',
            'The idempotency key was already used for a different request.',
            409,
          );
        }
        return clone(prior.response as T);
      }

      const { result, audit } = await change(store);
      const event = this.buildAuditEvent(userId, context, audit);
      await store.appendAuditEvent(userId, event);
      await store.saveIdempotency(userId, operation, context.idempotency_key, {
        request_hash: hash,
        response: clone(result),
        audit_event_id: event.event_id,
        resource_id: audit.resourceId,
      });
      return clone(result);
    });
  }

  private buildAuditEvent(userId: string, context: MutationContext, change: AuditChange): AuditEvent {
    return {
      event_id: randomUUID(),
      occurred_at: this.now(),
      actor: { type: 'user', id: context.actor_id },
      action: change.action,
      resource: { type: change.resourceType, id: change.resourceId },
      outcome: 'succeeded',
      tenant_id: userId,
      request_id: context.request_id,
      correlation_id: context.correlation_id,
      changed_fields: [...new Set(change.changedFields)].sort(),
      ...(context.causation_id ? { causation_id: context.causation_id } : {}),
      ...(change.beforeStatus ? { from_status: change.beforeStatus } : {}),
      ...(change.afterStatus ? { to_status: change.afterStatus } : {}),
    };
  }

  private async requireOwned<T>(
    userId: string,
    resourceId: string,
    resourceName: string,
    fetch: () => Promise<T | undefined>,
  ): Promise<T> {
    this.validateUuid(userId, 'user_id');
    this.validateUuid(resourceId, `${resourceName}_id`);
    const resource = await fetch();
    if (!resource) {
      throw new ProfileError('RESOURCE_NOT_FOUND', `${resourceName} was not found.`, 404);
    }
    return resource;
  }

  private async listGoalsFrom(store: ProfileStore, userId: string, includeArchived = false): Promise<Goal[]> {
    this.validateUuid(userId, 'user_id');
    return store.listGoals(userId, includeArchived);
  }

  private async listFactsFrom(
    store: ProfileStore,
    userId: string,
    filter: FactListFilter = {},
  ): Promise<Fact[]> {
    this.validateUuid(userId, 'user_id');
    const facts = await store.listFacts(userId, filter.include_deleted);
    return facts.filter(
      (fact) => (!filter.status || fact.status === filter.status) && (!filter.kind || fact.kind === filter.kind),
    );
  }

  private async listFileMetadataFrom(store: ProfileStore, userId: string): Promise<FileMetadata[]> {
    this.validateUuid(userId, 'user_id');
    return store.listFiles(userId);
  }

  private async listAuditEventsFrom(store: ProfileStore, userId: string): Promise<AuditEvent[]> {
    this.validateUuid(userId, 'user_id');
    return store.listAuditEvents(userId);
  }

  private async validateFactInput(
    store: ProfileStore,
    userId: string,
    input: CreateFactInput,
  ): Promise<void> {
    if (!isRecord(input)) {
      throw this.validation('fact must be an object.');
    }
    const allowedKinds = new Set([
      'identity',
      'contact',
      'summary',
      'experience',
      'education',
      'skill',
      'certification',
      'project',
      'work_authorization',
      'preference',
    ]);
    if (!allowedKinds.has(input.kind)) {
      throw this.validation('fact kind is invalid.');
    }
    if (input.user_confirmed !== undefined && typeof input.user_confirmed !== 'boolean') {
      throw this.validation('user_confirmed must be a boolean.');
    }
    this.rejectUnknownKeys(
      input,
      new Set(['kind', 'value', 'scope', 'source', 'valid_from', 'valid_until', 'user_confirmed']),
      'fact',
    );
    if (
      !isRecord(input.value) ||
      Object.keys(input.value).length < 1 ||
      Object.keys(input.value).length > 50 ||
      Object.values(input.value).some(
        (value) =>
          !(
            value === null ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value)) ||
            (typeof value === 'string' && value.length <= 10_000)
          ),
      )
    ) {
      throw this.validation('fact value is invalid.');
    }
    if (!isRecord(input.scope)) {
      throw this.validation('fact scope is invalid.');
    }
    this.rejectUnknownKeys(input.scope, new Set(['use', 'goal_ids']), 'fact scope');
    const scopeUses = new Set(['all_goals', 'selected_goals', 'manual_only', 'prohibited']);
    if (!scopeUses.has(input.scope.use)) {
      throw this.validation('fact scope use is invalid.');
    }
    const goalIds = input.scope.goal_ids ?? [];
    if (
      !Array.isArray(goalIds) ||
      goalIds.length > 100 ||
      new Set(goalIds).size !== goalIds.length ||
      goalIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))
    ) {
      throw this.validation('scope goal_ids is invalid.');
    }
    if (input.scope.use === 'selected_goals' && goalIds.length === 0) {
      throw this.validation('selected_goals requires goal_ids.');
    }
    if (input.scope.use !== 'selected_goals' && goalIds.length > 0) {
      throw this.validation('goal_ids is only allowed for selected_goals.');
    }
    for (const goalId of goalIds) {
      await this.requireOwned(userId, goalId, 'goal', () => store.getGoal(userId, goalId));
    }
    if (
      !isRecord(input.source) ||
      !['user', 'file', 'system_rule'].includes(input.source.type) ||
      typeof input.source.reference !== 'string' ||
      input.source.reference.length < 1 ||
      input.source.reference.length > 512
    ) {
      throw this.validation('fact source is invalid.');
    }
    this.rejectUnknownKeys(input.source, new Set(['type', 'reference']), 'fact source');
    this.validateDateRange(input.valid_from, input.valid_until);
  }

  private validateGoalInput(input: CreateGoalInput): void {
    if (!isRecord(input)) {
      throw this.validation('goal must be an object.');
    }
    const keys = new Set([
      'name',
      'title_keywords',
      'locations',
      'employment_types',
      'salary',
      'work_authorization_rule',
      'locale',
      'status',
    ]);
    this.rejectUnknownKeys(input, keys, 'goal');
    if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 120) {
      throw this.validation('name must contain 1-120 characters.');
    }
    this.validateStringList(input.title_keywords, 'title_keywords', 1, 50, 80);
    this.validateStringList(input.locations, 'locations', 0, 50, 160);
    const employmentTypes = new Set([
      'full_time',
      'part_time',
      'contract',
      'internship',
      'temporary',
      'other',
    ]);
    if (
      !Array.isArray(input.employment_types) ||
      input.employment_types.length < 1 ||
      new Set(input.employment_types).size !== input.employment_types.length ||
      input.employment_types.some((item) => !employmentTypes.has(item))
    ) {
      throw this.validation('employment_types is invalid.');
    }
    if (input.status !== 'active' && input.status !== 'paused') {
      throw this.validation('new goals must be active or paused.');
    }
    if (input.locale && !LOCALE_PATTERN.test(input.locale)) {
      throw this.validation('locale is invalid.');
    }
    if (
      input.work_authorization_rule &&
      !['authorized', 'requires_sponsorship', 'unknown', 'manual_only'].includes(
        input.work_authorization_rule,
      )
    ) {
      throw this.validation('work_authorization_rule is invalid.');
    }
    if (input.salary) {
      this.validateSalary(input.salary);
    }
  }

  private validateGoalPatch(input: UpdateGoalInput): void {
    this.rejectUnknownKeys(
      input,
      new Set([
        'name',
        'title_keywords',
        'locations',
        'employment_types',
        'salary',
        'work_authorization_rule',
        'locale',
        'status',
      ]),
      'goal update',
    );
    const candidate: CreateGoalInput = {
      name: input.name ?? 'valid',
      title_keywords: input.title_keywords ?? ['valid'],
      locations: input.locations ?? [],
      employment_types: input.employment_types ?? ['full_time'],
      status: input.status === 'archived' ? 'active' : (input.status ?? 'active'),
      ...(input.salary ? { salary: input.salary } : {}),
      ...(input.work_authorization_rule
        ? { work_authorization_rule: input.work_authorization_rule }
        : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    };
    this.validateGoalInput(candidate);
    if (input.status && !['active', 'paused', 'archived'].includes(input.status)) {
      throw this.validation('goal status is invalid.');
    }
  }

  private validateSalary(salary: CreateGoalInput['salary']): void {
    if (
      !salary ||
      !/^[A-Z]{3}$/.test(salary.currency) ||
      (salary.period !== undefined && !['hour', 'month', 'year'].includes(salary.period)) ||
      (salary.minimum !== undefined && (!Number.isFinite(salary.minimum) || salary.minimum < 0)) ||
      (salary.maximum !== undefined && (!Number.isFinite(salary.maximum) || salary.maximum < 0)) ||
      (salary.minimum !== undefined &&
        salary.maximum !== undefined &&
        salary.minimum > salary.maximum)
    ) {
      throw this.validation('salary is invalid.');
    }
    this.rejectUnknownKeys(salary, new Set(['minimum', 'maximum', 'currency', 'period']), 'salary');
  }

  private validateFileInput(input: CreateFileMetadataInput): void {
    if (!isRecord(input)) {
      throw this.validation('file metadata must be an object.');
    }
    const purposes = new Set([
      'resume_source',
      'resume_output',
      'cover_letter',
      'portfolio',
      'transcript',
      'application_evidence',
      'other',
    ]);
    const mediaTypes = new Set([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/png',
      'image/jpeg',
    ]);
    const scanStatuses = new Set(['pending', 'clean', 'quarantined', 'infected', 'failed']);
    this.rejectUnknownKeys(
      input,
      new Set(['purpose', 'display_name', 'media_type', 'byte_size', 'sha256', 'scan_status']),
      'file metadata',
    );
    if (
      !purposes.has(input.purpose) ||
      typeof input.display_name !== 'string' ||
      input.display_name.length < 1 ||
      input.display_name.length > 255 ||
      !mediaTypes.has(input.media_type) ||
      !Number.isInteger(input.byte_size) ||
      input.byte_size < 1 ||
      input.byte_size > 26_214_400 ||
      !SHA256_PATTERN.test(input.sha256) ||
      (input.scan_status !== undefined && !scanStatuses.has(input.scan_status))
    ) {
      throw this.validation('file metadata is invalid.');
    }
  }

  private validateDateRange(from?: string, until?: string): void {
    if (
      (from && (!RFC3339_PATTERN.test(from) || !Number.isFinite(Date.parse(from)))) ||
      (until && (!RFC3339_PATTERN.test(until) || !Number.isFinite(Date.parse(until)))) ||
      (from && until && Date.parse(from) >= Date.parse(until))
    ) {
      throw this.validation('fact validity range is invalid.');
    }
  }

  private validateStringList(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
    itemMaximum: number,
  ): void {
    if (
      !Array.isArray(value) ||
      value.length < minimum ||
      value.length > maximum ||
      new Set(value).size !== value.length ||
      value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > itemMaximum)
    ) {
      throw this.validation(`${field} is invalid.`);
    }
  }

  private validateNonEmptyUpdate(input: object): void {
    if (!isRecord(input) || Object.keys(input).length === 0) {
      throw this.validation('update must contain at least one field.');
    }
  }

  private rejectUnknownKeys(value: object, allowed: Set<string>, label: string): void {
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw this.validation(`${label} contains an unknown field.`);
    }
  }

  private validateUuid(value: string, field: string): void {
    if (!UUID_PATTERN.test(value)) {
      throw this.validation(`${field} must be a UUID.`);
    }
  }

  private invalidTransition(from: string, to: string): ProfileError {
    return new ProfileError(
      'STATE_TRANSITION_INVALID',
      `Fact cannot transition from ${from} to ${to}.`,
      409,
    );
  }

  private validation(message: string): ProfileError {
    return new ProfileError('VALIDATION_FAILED', message, 400);
  }

  private assertVersion(actual: number, expected: number): void {
    if (!Number.isInteger(expected) || expected < 1) {
      throw new ProfileError(
        'VALIDATION_FAILED',
        'expected_version must be a positive integer.',
        400,
      );
    }
    if (actual !== expected) {
      throw new ProfileError(
        'CONFLICT',
        'The resource version does not match expected_version.',
        409,
      );
    }
  }

  private validateUserAndContext(userId: string, context: MutationContext): void {
    this.validateUuid(userId, 'user_id');
    if (!isRecord(context)) {
      throw this.validation('Mutation context is required.');
    }
    if (context.actor_id !== userId) {
      throw new ProfileError(
        'VALIDATION_FAILED',
        'actor_id must identify the authenticated user.',
        400,
      );
    }
    if (
      typeof context.request_id !== 'string' ||
      !UUID_PATTERN.test(context.request_id) ||
      typeof context.correlation_id !== 'string' ||
      !UUID_PATTERN.test(context.correlation_id) ||
      (context.causation_id !== undefined &&
        (typeof context.causation_id !== 'string' || !UUID_PATTERN.test(context.causation_id))) ||
      typeof context.idempotency_key !== 'string' ||
      !IDEMPOTENCY_KEY_PATTERN.test(context.idempotency_key)
    ) {
      throw new ProfileError(
        'VALIDATION_FAILED',
        'Mutation context UUIDs and a 16-128 character idempotency key are required.',
        400,
      );
    }
  }

  private now(): string {
    return new Date().toISOString();
  }
}
