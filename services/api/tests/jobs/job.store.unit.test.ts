import { describe, expect, it } from 'vitest';

import { InMemoryJobStore } from '../../src/modules/jobs/job.store';
import type { Job } from '../../src/modules/jobs/job.types';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    canonical_url: 'https://careers.example.test/jobs/backend-engineer',
    source: 'manual_url',
    source_refs: [
      {
        type: 'manual_url',
        reference: 'BE-1',
        captured_at: '2026-07-20T09:00:00.000Z',
        content_hash: 'a'.repeat(64),
      },
    ],
    title: 'Backend Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    employment_type: 'full_time',
    description_status: 'complete',
    risk: { level: 'low', reasons: [], requires_manual_review: false },
    status: 'active',
    version: 1,
    created_at: '2026-07-20T09:00:00.000Z',
    updated_at: '2026-07-20T09:00:00.000Z',
    ...overrides,
  };
}

describe('InMemoryJobStore', () => {
  it('saves and retrieves clones so callers cannot mutate stored state', async () => {
    const store = new InMemoryJobStore();
    const job = makeJob();

    const saved = await store.saveJob(job);
    saved.title = 'Mutated Title';
    job.title = 'Mutated Title';

    const fetched = await store.getJob(job.id);
    expect(fetched?.title).toBe('Backend Engineer');
    expect(fetched).not.toBe(saved);
  });

  it('returns null for a job id that does not exist', async () => {
    const store = new InMemoryJobStore();
    expect(await store.getJob('missing')).toBeNull();
  });

  it('lists jobs filtered by source, status, employment type and company', async () => {
    const store = new InMemoryJobStore();
    await store.saveJob(
      makeJob({
        id: '11111111-1111-4111-8111-111111111111',
        source: 'manual_url',
        status: 'active',
        employment_type: 'full_time',
        company: 'Acme Corp',
        created_at: '2026-07-20T09:00:00.000Z',
      }),
    );
    await store.saveJob(
      makeJob({
        id: '22222222-2222-4222-8222-222222222222',
        source: 'greenhouse',
        status: 'risk_review',
        employment_type: 'contract',
        company: 'Other Inc',
        created_at: '2026-07-21T09:00:00.000Z',
      }),
    );

    expect((await store.listJobs()).map((j) => j.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect((await store.listJobs({ source: 'greenhouse' })).map((j) => j.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect((await store.listJobs({ status: 'active' })).map((j) => j.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect((await store.listJobs({ employmentType: 'contract' })).map((j) => j.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect((await store.listJobs({ company: 'Acme Corp' })).map((j) => j.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('deletes a job and reports whether it existed', async () => {
    const store = new InMemoryJobStore();
    await store.saveJob(makeJob());

    expect(await store.deleteJob('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(await store.deleteJob('11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(await store.getJob('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('runs withTransaction against the same store instance', async () => {
    const store = new InMemoryJobStore();
    const result = await store.withTransaction(async (tx) => {
      await tx.saveJob(makeJob());
      return tx.listJobs();
    });
    expect(result).toHaveLength(1);
  });
});
