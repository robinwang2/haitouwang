import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  JobImportError,
  runJobImportPipeline,
  type JobImportDocument,
} from '../../src/modules/jobs';

const NOW = '2026-07-30T12:00:00.000Z';
const FIXTURE_NAMES = ['greenhouse', 'lever', 'careers', 'manual-url'] as const;

function readFixtures(): JobImportDocument[] {
  return FIXTURE_NAMES.map((name) => {
    const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
    return JSON.parse(readFileSync(path, 'utf8')) as JobImportDocument;
  });
}

function readTextFixture(name: string): string {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(path, 'utf8');
}

describe('runJobImportPipeline', () => {
  it('replays fixed fixtures deterministically and keeps one canonical cross-source job', () => {
    const fixtures = readFixtures();

    const firstRun = runJobImportPipeline(fixtures, { now: NOW });
    const replay = runJobImportPipeline(readFixtures(), { now: NOW });
    const reverseOrderReplay = runJobImportPipeline([...readFixtures()].reverse(), {
      now: NOW,
    });

    expect(replay).toEqual(firstRun);
    expect(reverseOrderReplay).toEqual(firstRun);
    expect(firstRun).toHaveLength(2);

    const canonical = firstRun.find((job) => job.title === 'Senior Software Engineer');
    expect(canonical).toMatchObject({
      canonical_url: 'https://careers.acme.example/jobs/senior-software-engineer',
      source: 'company_careers',
      company: 'Acme, Inc.',
      location: 'New York, NY',
      employment_type: 'full_time',
      description_status: 'complete',
      risk: {
        level: 'low',
        reasons: [],
        requires_manual_review: false,
      },
      status: 'active',
      version: 1,
      salary: {
        currency: 'USD',
        minimum: 175000,
        maximum: 220000,
        period: 'year',
      },
    });
    expect(canonical?.source_refs.map((ref) => ref.type)).toEqual([
      'company_careers',
      'greenhouse',
      'lever',
    ]);
    expect(canonical?.source_refs.every((ref) => /^[a-f0-9]{64}$/.test(ref.content_hash))).toBe(
      true,
    );

    const expired = firstRun.find((job) => job.title === 'Data Engineer');
    expect(expired).toMatchObject({
      canonical_url: 'https://careers.example.org/jobs/data-engineer',
      source: 'manual_url',
      employment_type: 'contract',
      status: 'expired',
    });
  });

  it('extracts a structured Careers posting from a fixed HTML page', () => {
    const [job] = runJobImportPipeline(
      [
        {
          source: 'company_careers',
          url: 'https://careers.northstar.example/jobs/platform-engineer',
          fetched_at: '2026-07-23T11:00:00.000Z',
          payload: readTextFixture('careers-page.html'),
        },
      ],
      { now: NOW },
    );

    expect(job).toMatchObject({
      canonical_url: 'https://careers.northstar.example/jobs/platform-engineer',
      source: 'company_careers',
      title: 'Platform Engineer',
      company: 'Northstar Labs',
      location: 'Remote',
      employment_type: 'full_time',
      description_status: 'complete',
      status: 'active',
    });
  });

  it('sends suspicious or incomplete active postings to manual risk review', () => {
    const [job] = runJobImportPipeline(
      [
        {
          source: 'manual_url',
          url: 'http://jobs.example.test/support-specialist?utm_source=message',
          fetched_at: '2026-07-29T08:00:00.000Z',
          payload: {
            '@type': 'JobPosting',
            identifier: 'SUPPORT-9',
            title: 'Support Specialist',
            hiringOrganization: { name: 'Example Test' },
            jobLocation: { address: { addressLocality: 'Remote' } },
            employmentType: 'FULL_TIME',
            description:
              'Contact our recruiter on Telegram and pay an application fee before the interview. We will send the complete responsibilities after you make the deposit.',
            validThrough: '2026-08-30T00:00:00.000Z',
          },
        },
      ],
      { now: NOW },
    );

    expect(job.canonical_url).toBe('http://jobs.example.test/support-specialist');
    expect(job.status).toBe('risk_review');
    expect(job.risk).toEqual({
      level: 'high',
      reasons: [
        'description_partial',
        'insecure_posting_url',
        'payment_requested',
        'personal_messaging_contact',
      ],
      requires_manual_review: true,
    });
  });

  it('does not collapse separate requisitions from the same source by title alone', () => {
    const base = readFixtures()[0];
    const second = structuredClone(base);
    second.url = 'https://job-boards.greenhouse.io/acme/jobs/1002';
    second.payload = {
      ...(second.payload as Record<string, unknown>),
      id: 1002,
      absolute_url: second.url,
    };

    const result = runJobImportPipeline([base, second], { now: NOW });

    expect(result).toHaveLength(2);
    expect(new Set(result.map((job) => job.id)).size).toBe(2);
    expect(result.map((job) => job.source_refs[0].reference).sort()).toEqual(['1001', '1002']);
  });

  it('rejects a payload without the required normalized title', () => {
    expect(() =>
      runJobImportPipeline(
        [
          {
            source: 'manual_url',
            url: 'https://careers.example.test/jobs/missing-title',
            fetched_at: '2026-07-29T08:00:00.000Z',
            payload: {
              '@type': 'JobPosting',
              hiringOrganization: { name: 'Example Test' },
            },
          },
        ],
        { now: NOW },
      ),
    ).toThrowError(JobImportError);
  });
});
