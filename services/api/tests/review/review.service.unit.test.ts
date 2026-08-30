import { describe, expect, it } from 'vitest';

import { InMemoryReviewStore, ReviewService, type Review } from '../../src/modules/review';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const NOW = '2026-08-29T00:00:00.000Z';

describe('ReviewService persistence', () => {
  it('saves, gets and lists reviews through the injected store with tenant isolation', async () => {
    const service = new ReviewService(new InMemoryReviewStore());
    const saved = await service.save(review());

    expect(await service.get(USER_ID, saved.id)).toEqual(saved);
    expect(await service.list(USER_ID)).toEqual([saved]);
    await expect(service.get(OTHER_USER_ID, saved.id)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('resolves findings and persists the updated review', async () => {
    const service = new ReviewService(new InMemoryReviewStore(), () => NOW);
    const saved = await service.save(review());
    const resolved = await service.resolveFinding(USER_ID, saved.id, saved.findings[0]!.id);

    expect(resolved).toMatchObject({
      status: 'approved',
      recommendation: 'approve',
      version: 2,
      updated_at: NOW,
    });
    expect(resolved.findings[0]).toMatchObject({ status: 'resolved' });
    expect(await service.get(USER_ID, saved.id)).toEqual(resolved);
  });

  it('maps duplicate review ids to a domain conflict', async () => {
    const service = new ReviewService(new InMemoryReviewStore());
    await service.save(review());

    await expect(service.save(review())).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

function review(): Review {
  return {
    id: '60000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    job_id: '20000000-0000-4000-8000-000000000001',
    material_ids: ['30000000-0000-4000-8000-000000000001'],
    material_versions: { '30000000-0000-4000-8000-000000000001': 1 },
    status: 'requires_changes',
    reviewers: ['fact_check'],
    findings: [
      {
        id: '70000000-0000-4000-8000-000000000001',
        reviewer: 'fact_check',
        severity: 'must_fix',
        category: 'fabricated_claim',
        message: 'Resolve this finding.',
        evidence_refs: [],
        status: 'open',
      },
    ],
    recommendation: 'revise',
    round: 1,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}
