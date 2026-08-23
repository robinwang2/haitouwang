import { deepEqual, equal, match, notEqual, rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';

import { InMemoryProfileStore, ProfileError, ProfileService } from '../../src/modules/profile';
import type { MutationContext } from '../../src/modules/profile';

function fixture() {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const store = new InMemoryProfileStore();
  const service = new ProfileService(store);
  let sequence = 0;
  const context = (user = userId): MutationContext => {
    sequence += 1;
    return {
      actor_id: user,
      request_id: randomUUID(),
      correlation_id: randomUUID(),
      idempotency_key: `profile-test-key-${sequence.toString().padStart(6, '0')}`,
    };
  };
  return { userId, otherUserId, service, store, context };
}

function createGoal(
  service: ProfileService,
  userId: string,
  context: () => MutationContext,
  name = 'Backend roles',
) {
  return service.createGoal(
    userId,
    {
      name,
      title_keywords: ['Backend Engineer'],
      locations: ['Remote'],
      employment_types: ['full_time'],
      work_authorization_rule: 'authorized',
      status: 'active',
    },
    context(),
  );
}

describe('ProfileService goals', () => {
  it('supports isolated multi-goal CRUD, optimistic versions and audit', async () => {
    const { userId, otherUserId, service, context } = fixture();
    const first = await createGoal(service, userId, context, 'Backend');
    const second = await createGoal(service, userId, context, 'Platform');
    await createGoal(service, otherUserId, () => context(otherUserId), 'Other tenant');

    deepEqual(
      (await service.listGoals(userId)).map((goal) => goal.name).sort(),
      ['Backend', 'Platform'],
    );
    await rejects(
      service.getGoal(otherUserId, first.id),
      (error: unknown) =>
        error instanceof ProfileError &&
        error.code === 'RESOURCE_NOT_FOUND' &&
        error.status === 404,
    );

    const updated = await service.updateGoal(
      userId,
      first.id,
      1,
      { status: 'paused', locations: ['Seattle, WA'] },
      context(),
    );
    equal(updated.version, 2);
    equal((await service.getGoalVersions(userId, first.id)).length, 2);
    await rejects(
      service.updateGoal(userId, first.id, 1, { status: 'active' }, context()),
      (error: unknown) => error instanceof ProfileError && error.code === 'CONFLICT',
    );

    await service.deleteGoal(userId, second.id, 1, context());
    equal((await service.listGoals(userId, true)).length, 1);
    const actions = (await service.listAuditEvents(userId)).map((event) => event.action);
    deepEqual(actions, ['goal.created', 'goal.created', 'goal.updated', 'goal.deleted']);
    const updateAudit = (await service.listAuditEvents(userId)).find(
      (event) => event.action === 'goal.updated',
    );
    equal(updateAudit?.from_status, 'active');
    equal(updateAudit?.to_status, 'paused');
    equal('before_status' in (updateAudit ?? {}), false);
    equal('after_status' in (updateAudit ?? {}), false);
  });
});

describe('ProfileService facts', () => {
  it('versions confirmation, changes and revocation without exposing values in audit', async () => {
    const { userId, service, context } = fixture();
    const goal = await createGoal(service, userId, context);
    const secretValue = 'sensitive-private-employer';
    const pending = await service.createFact(
      userId,
      {
        kind: 'experience',
        value: { employer: secretValue, years: 4 },
        scope: { use: 'all_goals' },
        source: { type: 'user', reference: 'profile-form' },
      },
      context(),
    );

    equal(pending.status, 'pending_confirmation');
    equal(await service.isFactUsable(userId, pending.id, goal.id), false);
    const confirmed = await service.confirmFact(userId, pending.id, pending.version, context());
    equal(confirmed.status, 'active');
    equal(await service.isFactUsable(userId, pending.id, goal.id), true);

    const changed = await service.updateFact(
      userId,
      pending.id,
      confirmed.version,
      { value: { employer: secretValue, years: 5 } },
      context(),
    );
    equal(changed.status, 'pending_confirmation');
    equal(changed.confirmed_at, undefined);
    equal(await service.isFactUsable(userId, pending.id, goal.id), false);
    const reconfirmed = await service.confirmFact(userId, pending.id, changed.version, context());
    const revoked = await service.revokeFact(userId, pending.id, reconfirmed.version, context());
    equal(revoked.status, 'revoked');
    equal(await service.isFactUsable(userId, pending.id, goal.id), false);
    deepEqual(
      (await service.getFactVersions(userId, pending.id)).map((version) => version.version),
      [1, 2, 3, 4, 5],
    );
    equal(JSON.stringify(await service.listAuditEvents(userId)).includes(secretValue), false);
  });

  it('never returns pending, expired, prohibited, manual-only or out-of-scope facts as usable', async () => {
    const { userId, service, context } = fixture();
    const selectedGoal = await createGoal(service, userId, context, 'Selected');
    const otherGoal = await createGoal(service, userId, context, 'Other');
    const base = {
      kind: 'skill' as const,
      value: { name: 'TypeScript' },
      source: { type: 'user' as const, reference: 'profile-form' },
    };
    const pending = await service.createFact(userId, { ...base, scope: { use: 'all_goals' } }, context());
    const timeRestricted = await service.createFact(
      userId,
      {
        ...base,
        scope: { use: 'all_goals' },
        user_confirmed: true,
        valid_until: '2020-01-01T00:00:00.000Z',
      },
      context(),
    );
    const prohibited = await service.createFact(
      userId,
      {
        ...base,
        scope: { use: 'prohibited' },
        user_confirmed: true,
      },
      context(),
    );
    const manual = await service.createFact(
      userId,
      {
        ...base,
        scope: { use: 'manual_only' },
        user_confirmed: true,
      },
      context(),
    );
    const selected = await service.createFact(
      userId,
      {
        ...base,
        scope: { use: 'selected_goals', goal_ids: [selectedGoal.id] },
        user_confirmed: true,
      },
      context(),
    );
    const explicitlyExpiredSource = await service.createFact(
      userId,
      {
        ...base,
        scope: { use: 'all_goals' },
        user_confirmed: true,
      },
      context(),
    );
    const explicitlyExpired = await service.expireFact(
      userId,
      explicitlyExpiredSource.id,
      explicitlyExpiredSource.version,
      context(),
    );
    const rejectedSource = await service.createFact(
      userId,
      { ...base, scope: { use: 'all_goals' } },
      context(),
    );
    const rejected = await service.rejectFact(
      userId,
      rejectedSource.id,
      rejectedSource.version,
      context(),
    );

    equal(await service.isFactUsable(userId, pending.id, selectedGoal.id), false);
    equal(await service.isFactUsable(userId, timeRestricted.id, selectedGoal.id), false);
    equal(await service.isFactUsable(userId, prohibited.id, selectedGoal.id), false);
    equal(await service.isFactUsable(userId, manual.id, selectedGoal.id), false);
    equal(await service.isFactUsable(userId, explicitlyExpired.id, selectedGoal.id), false);
    equal(await service.isFactUsable(userId, rejected.id, selectedGoal.id), false);
    equal(await service.isFactUsable(userId, selected.id, selectedGoal.id), true);
    equal(await service.isFactUsable(userId, selected.id, otherGoal.id), false);
    deepEqual(
      (await service.listUsableFacts(userId, selectedGoal.id)).map((fact) => fact.id),
      [selected.id],
    );
  });

  it('only supplies confirmed, in-scope work authorization facts', async () => {
    const { userId, service, context } = fixture();
    const goal = await createGoal(service, userId, context);
    await service.createFact(
      userId,
      {
        kind: 'work_authorization',
        value: { jurisdiction: 'unspecified', authorized: true },
        scope: { use: 'all_goals' },
        source: { type: 'user', reference: 'profile-form' },
      },
      context(),
    );
    const available = await service.createFact(
      userId,
      {
        kind: 'work_authorization',
        value: { jurisdiction: 'unspecified', requires_sponsorship: false },
        scope: { use: 'all_goals' },
        source: { type: 'user', reference: 'profile-form' },
        user_confirmed: true,
      },
      context(),
    );

    deepEqual(
      (await service.getUsableWorkAuthorizationFacts(userId, goal.id)).map((fact) => fact.id),
      [available.id],
    );
  });

  it('enforces the fact state machine and scrubs deleted fact history', async () => {
    const { userId, service, store, context } = fixture();
    const fact = await service.createFact(
      userId,
      {
        kind: 'identity',
        value: { legal_name: 'Sensitive Name' },
        scope: { use: 'manual_only' },
        source: { type: 'user', reference: 'profile-form' },
      },
      context(),
    );
    await rejects(
      service.revokeFact(userId, fact.id, fact.version, context()),
      (error: unknown) =>
        error instanceof ProfileError && error.code === 'STATE_TRANSITION_INVALID',
    );
    const deleted = await service.deleteFact(userId, fact.id, fact.version, context());
    equal(deleted.status, 'deleted');
    deepEqual(deleted.value, { deleted: true });
    const serializedHistory = JSON.stringify(await service.getFactVersions(userId, fact.id));
    equal(serializedHistory.includes('Sensitive Name'), false);
    equal(JSON.stringify([...store.idempotency.values()]).includes('Sensitive Name'), false);
    equal((await service.listFacts(userId)).length, 0);
    equal((await service.listFacts(userId, { include_deleted: true })).length, 1);
  });
});

describe('ProfileService resume files, export and deletion', () => {
  it('versions scan state and only exposes clean resume metadata as usable', async () => {
    const { userId, service, context } = fixture();
    const file = await service.createFileMetadata(
      userId,
      {
        purpose: 'resume_source',
        display_name: 'resume.pdf',
        media_type: 'application/pdf',
        byte_size: 1024,
        sha256: 'a'.repeat(64),
      },
      context(),
    );
    equal((await service.listUsableResumeFiles(userId)).length, 0);
    const clean = await service.updateFileScanStatus(userId, file.id, file.version, 'clean', context());
    equal((await service.listUsableResumeFiles(userId))[0]?.id, file.id);
    const quarantined = await service.updateFileScanStatus(
      userId,
      file.id,
      clean.version,
      'quarantined',
      context(),
    );
    equal((await service.listUsableResumeFiles(userId)).length, 0);
    deepEqual(
      (await service.getFileVersions(userId, file.id)).map((version) => version.version),
      [1, 2, 3],
    );
    await service.deleteFileMetadata(userId, file.id, quarantined.version, context());
    equal((await service.listFileMetadata(userId)).length, 0);
  });

  it('exports one tenant and deletes profile data while retaining content-free audit proof', async () => {
    const { userId, otherUserId, service, context } = fixture();
    await createGoal(service, userId, context);
    await createGoal(service, otherUserId, () => context(otherUserId), 'Other tenant');
    await service.createFact(
      userId,
      {
        kind: 'summary',
        value: { text: 'private summary' },
        scope: { use: 'all_goals' },
        source: { type: 'user', reference: 'profile-form' },
      },
      context(),
    );

    const exported = await service.exportProfile(userId, context());
    equal(exported.schema_version, '1.0.0');
    equal(exported.goals.length, 1);
    equal(exported.facts.length, 1);
    equal(
      exported.goals.every((goal) => goal.user_id === userId),
      true,
    );

    const counts = await service.deleteUserProfile(userId, context());
    deepEqual(counts, { goals: 1, facts: 1, files: 0 });
    equal((await service.listGoals(userId, true)).length, 0);
    equal((await service.listFacts(userId, { include_deleted: true })).length, 0);
    equal((await service.listGoals(otherUserId, true)).length, 1);
    const finalAudit = (await service.listAuditEvents(userId)).at(-1);
    equal(finalAudit?.action, 'profile.deleted');
    equal(finalAudit?.resource.type, 'user');
    equal(JSON.stringify(finalAudit).includes('private summary'), false);
  });
});

describe('ProfileService idempotency', () => {
  it('replays identical creation and rejects an idempotency key reused with other input', async () => {
    const { userId, service } = fixture();
    const context: MutationContext = {
      actor_id: userId,
      request_id: randomUUID(),
      correlation_id: randomUUID(),
      idempotency_key: 'same-idempotency-key-0001',
    };
    const input = {
      name: 'Backend',
      title_keywords: ['Backend Engineer'],
      locations: ['Remote'],
      employment_types: ['full_time'] as const,
      status: 'active' as const,
    };
    const first = await service.createGoal(
      userId,
      { ...input, employment_types: [...input.employment_types] },
      context,
    );
    const replay = await service.createGoal(
      userId,
      { ...input, employment_types: [...input.employment_types] },
      context,
    );
    equal(replay.id, first.id);
    equal((await service.listGoals(userId)).length, 1);
    equal((await service.listAuditEvents(userId)).length, 1);
    await rejects(
      service.createGoal(
        userId,
        {
          ...input,
          name: 'Changed',
          employment_types: [...input.employment_types],
        },
        context,
      ),
      (error: unknown) => error instanceof ProfileError && error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
    notEqual(first.id, randomUUID());
    match(first.id, /^[0-9a-f-]{36}$/);
  });
});

describe('ProfileService validation', () => {
  it('returns domain validation errors for malformed runtime inputs', async () => {
    const { userId, service, context } = fixture();
    await rejects(
      service.createGoal(
        userId,
        {
          name: 'Backend',
          title_keywords: ['Backend Engineer'],
          locations: ['Remote'],
          employment_types: ['full_time'],
          status: 'active',
        },
        { ...context(), request_id: 'not-a-uuid' },
      ),
      (error: unknown) =>
        error instanceof ProfileError && error.code === 'VALIDATION_FAILED' && error.status === 400,
    );
    await rejects(
      service.createFileMetadata(userId, null as never, context()),
      (error: unknown) => error instanceof ProfileError && error.code === 'VALIDATION_FAILED',
    );
    await rejects(
      service.createFact(
        userId,
        {
          kind: 'skill',
          value: { name: 'TypeScript' },
          scope: { use: 'selected_goals', goal_ids: 'not-an-array' as never },
          source: { type: 'user', reference: 'profile-form' },
        },
        context(),
      ),
      (error: unknown) => error instanceof ProfileError && error.code === 'VALIDATION_FAILED',
    );
  });
});
