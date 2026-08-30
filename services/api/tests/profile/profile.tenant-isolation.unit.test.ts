import { rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';

import { InMemoryProfileStore, ProfileError, ProfileService } from '../../src/modules/profile';
import type { MutationContext } from '../../src/modules/profile';

/**
 * contracts/openapi/openapi.json has no GET /v1/goals/{goalId} or GET /v1/facts/{factId}
 * (only list/create are defined for this ticket's five endpoints), so there is no HTTP
 * route that fetches a single goal/fact by id to exercise cross-tenant 404s directly.
 * These tests cover the same tenant-scoped lookup (ProfileService#requireOwned) that such
 * a route would call, proving both goal and fact reads reject a non-owning tenant with the
 * exact status/code the contract's ErrorEnvelope expects (404 / RESOURCE_NOT_FOUND) - the
 * behavior that services/api/tests/profile/profile.controller.web-api.unit.test.ts confirms
 * is reachable over HTTP via POST /v1/facts referencing another tenant's goal.
 */
function fixture() {
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const store = new InMemoryProfileStore();
  const service = new ProfileService(store);
  let sequence = 0;
  const context = (actorId = ownerId): MutationContext => {
    sequence += 1;
    return {
      actor_id: actorId,
      request_id: randomUUID(),
      correlation_id: randomUUID(),
      idempotency_key: `tenant-isolation-${sequence.toString().padStart(6, '0')}`,
    };
  };
  return { ownerId, otherId, service, context };
}

describe('ProfileService tenant isolation', () => {
  it('returns RESOURCE_NOT_FOUND (404) for a goal owned by a different tenant', async () => {
    const { ownerId, otherId, service, context } = fixture();
    const goal = await service.createGoal(
      ownerId,
      {
        name: 'Backend roles',
        title_keywords: ['Backend Engineer'],
        locations: ['Remote'],
        employment_types: ['full_time'],
        status: 'active',
      },
      context(),
    );

    await rejects(
      service.getGoal(otherId, goal.id),
      (error: unknown) =>
        error instanceof ProfileError &&
        error.code === 'RESOURCE_NOT_FOUND' &&
        error.status === 404,
    );
  });

  it('returns RESOURCE_NOT_FOUND (404) for a fact owned by a different tenant', async () => {
    const { ownerId, otherId, service, context } = fixture();
    const fact = await service.createFact(
      ownerId,
      {
        kind: 'skill',
        value: { name: 'TypeScript' },
        scope: { use: 'all_goals' },
        source: { type: 'user', reference: 'onboarding-form' },
      },
      context(),
    );

    await rejects(
      service.getFact(otherId, fact.id),
      (caught: unknown) =>
        caught instanceof ProfileError &&
        caught.code === 'RESOURCE_NOT_FOUND' &&
        caught.status === 404,
    );
  });
});
