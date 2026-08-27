import { describe, expect, it } from 'vitest';

import { InMemoryJobStore } from '../../src/modules/jobs/job.store';
import { JobService } from '../../src/modules/jobs/job.service';
import type { JobImportDocument } from '../../src/modules/jobs/job.types';

const NOW = '2026-07-30T12:00:00.000Z';

function backendDocument(overrides: Record<string, unknown> = {}): JobImportDocument {
  return {
    source: 'manual_url',
    url: 'https://careers.example.test/jobs/backend-engineer',
    fetched_at: '2026-07-20T09:00:00.000Z',
    payload: {
      '@type': 'JobPosting',
      identifier: 'BE-1',
      title: 'Backend Engineer',
      hiringOrganization: { name: 'Acme Corp' },
      jobLocation: { address: { addressLocality: 'Remote' } },
      employmentType: 'FULL_TIME',
      description:
        'Build and operate backend services for the platform team, own reliability and on-call rotations, mentor other engineers, and collaborate closely with product on roadmap execution.',
      validThrough: '2026-12-31T23:59:59.000Z',
      ...(overrides.payload as Record<string, unknown> | undefined),
    },
  };
}

function frontendDocument(): JobImportDocument {
  return {
    source: 'manual_url',
    url: 'https://careers.example.test/jobs/frontend-engineer',
    fetched_at: '2026-07-20T09:00:00.000Z',
    payload: {
      '@type': 'JobPosting',
      identifier: 'FE-1',
      title: 'Frontend Engineer',
      hiringOrganization: { name: 'Acme Corp' },
      jobLocation: { address: { addressLocality: 'Remote' } },
      employmentType: 'FULL_TIME',
      description:
        'Build accessible, well tested user interfaces for the platform team, partner with design and backend engineers, and improve the reliability of the web application.',
      validThrough: '2026-12-31T23:59:59.000Z',
    },
  };
}

function fixture() {
  const store = new InMemoryJobStore();
  const service = new JobService(store);
  return { store, service };
}

describe('JobService.importJobs', () => {
  it('inserts new jobs at version 1 and passes through getJob/listJobs', async () => {
    const { service } = fixture();

    const imported = await service.importJobs([backendDocument(), frontendDocument()], { now: NOW });

    expect(imported).toHaveLength(2);
    expect(imported.every((job) => job.version === 1)).toBe(true);

    const listed = await service.listJobs();
    expect(listed).toHaveLength(2);

    const backend = imported.find((job) => job.title === 'Backend Engineer');
    expect(backend).toBeDefined();
    expect(await service.getJob(backend!.id)).toMatchObject({ id: backend!.id, version: 1 });
  });

  it('does not duplicate records on repeated imports and bumps version only when content changes', async () => {
    const { service } = fixture();
    const documents = [backendDocument(), frontendDocument()];

    const first = await service.importJobs(documents, { now: NOW });
    expect(first).toHaveLength(2);
    expect(first.every((job) => job.version === 1)).toBe(true);

    const second = await service.importJobs(documents, { now: NOW });
    const secondListing = await service.listJobs();
    expect(secondListing).toHaveLength(first.length);
    expect(second.every((job) => job.version === 1)).toBe(true);
    expect(new Set(second.map((job) => job.id))).toEqual(new Set(first.map((job) => job.id)));

    const frontendBefore = second.find((job) => job.title === 'Frontend Engineer');
    const backendBefore = second.find((job) => job.title === 'Backend Engineer');
    expect(frontendBefore).toBeDefined();
    expect(backendBefore).toBeDefined();

    const changedDocuments = [
      backendDocument({
        payload: { title: 'Senior Backend Engineer' },
      }),
      frontendDocument(),
    ];
    const third = await service.importJobs(changedDocuments, { now: '2026-08-01T00:00:00.000Z' });
    const thirdListing = await service.listJobs();
    expect(thirdListing).toHaveLength(first.length);

    const backendAfter = third.find((job) => job.id === backendBefore!.id);
    const frontendAfter = third.find((job) => job.id === frontendBefore!.id);

    expect(backendAfter).toBeDefined();
    expect(backendAfter?.title).toBe('Senior Backend Engineer');
    expect(backendAfter?.version).toBe(2);
    expect(backendAfter?.updated_at).not.toBe(backendBefore?.updated_at);
    expect(backendAfter?.updated_at).toBe('2026-08-01T00:00:00.000Z');

    expect(frontendAfter).toBeDefined();
    expect(frontendAfter?.version).toBe(1);
    expect(frontendAfter?.updated_at).toBe(frontendBefore?.updated_at);
  });
});
