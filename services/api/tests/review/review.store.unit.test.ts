import { describe, expect, it } from 'vitest';

import { InMemoryReviewStore, type Review } from '../../src/modules/review';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const NOW = '2026-07-31T12:00:00.000Z';

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: '60000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    job_id: '20000000-0000-4000-8000-000000000001',
    material_ids: ['30000000-0000-4000-8000-000000000001'],
    material_versions: { '30000000-0000-4000-8000-000000000001': 1 },
    status: 'queued',
    reviewers: ['ats', 'hard_requirements', 'fact_check', 'naturalness'],
    findings: [],
    recommendation: 'human_review',
    round: 1,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('InMemoryReviewStore', () => {
  it('round-trips a review and enforces tenant scoping on reads', async () => {
    const store = new InMemoryReviewStore();
    const saved = await store.saveReview(review());

    expect(await store.getReview(USER_ID, saved.id)).toEqual(saved);
    expect(await store.getReview(OTHER_USER_ID, saved.id)).toBeUndefined();
    expect((await store.listReviews(USER_ID)).map((row) => row.id)).toEqual([saved.id]);
    expect(await store.listReviews(OTHER_USER_ID)).toEqual([]);
  });

  it('rejects saving a review id that already exists', async () => {
    const store = new InMemoryReviewStore();
    await store.saveReview(review());
    await expect(store.saveReview(review())).rejects.toThrow();
  });

  it('updates an existing review only for the owning tenant', async () => {
    const store = new InMemoryReviewStore();
    const saved = await store.saveReview(review());
    const updated: Review = { ...saved, status: 'approved', recommendation: 'approve', version: 2 };

    await store.updateReview(OTHER_USER_ID, updated);
    expect(await store.getReview(USER_ID, saved.id)).toEqual(saved);

    await store.updateReview(USER_ID, updated);
    expect(await store.getReview(USER_ID, saved.id)).toEqual(updated);
  });

  it('commits writes performed inside withTransaction', async () => {
    const store = new InMemoryReviewStore();
    await store.withTransaction(async (scoped) => {
      await scoped.saveReview(review());
    });
    expect(await store.getReview(USER_ID, review().id)).toEqual(review());
  });
});
