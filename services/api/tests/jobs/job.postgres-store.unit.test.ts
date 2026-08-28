import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresJobStore } from '../../src/modules/jobs/job.postgres-store';
import type { Job } from '../../src/modules/jobs/job.types';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[job.postgres-store] DATABASE_URL is not set - skipping PostgresJobStore integration tests. ' +
      'Set DATABASE_URL to a disposable Postgres instance to exercise the real SQL implementation.',
  );
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/jobs',
);

async function migrationSql(suffix: '.up.sql' | '.down.sql'): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(suffix)).sort();
  return Promise.all(files.map((file) => readFile(path.join(MIGRATIONS_DIR, file), 'utf8')));
}

async function resetSchema(pool: Pool): Promise<void> {
  const downSqls = (await migrationSql('.down.sql')).reverse();
  for (const sql of downSqls) {
    await pool.query(sql);
  }
}

function jobFixture(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    canonical_url: 'https://boards.greenhouse.io/acme/jobs/12345',
    source: 'greenhouse',
    source_refs: [
      {
        type: 'greenhouse',
        reference: '12345',
        captured_at: now,
        content_hash: 'hash-1',
      },
    ],
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    employment_type: 'full_time',
    description_status: 'complete',
    risk: { level: 'low', reasons: [], requires_manual_review: false },
    status: 'discovered',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)('PostgresJobStore integration', () => {
  let pool: Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(pool);
    const upSqls = await migrationSql('.up.sql');
    for (const sql of upSqls) {
      await pool.query(sql);
    }
    store = new PostgresJobStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE jobs');
  });

  it('round-trips a job including nested salary, source_refs and risk', async () => {
    const job = jobFixture({
      salary: { minimum: 120_000, maximum: 160_000, currency: 'USD', period: 'year' },
      risk: { level: 'medium', reasons: ['unverified_company'], requires_manual_review: true },
    });

    const saved = await store.saveJob(job);
    expect(saved).toEqual(job);
    expect(await store.getJob(job.id)).toEqual(job);
    expect(await store.getJob(randomUUID())).toBeNull();
  });

  it('omits salary when not present on the domain object', async () => {
    const job = jobFixture();
    expect(job.salary).toBeUndefined();

    await store.saveJob(job);
    const fetched = await store.getJob(job.id);
    expect(fetched).toEqual(job);
    expect(fetched && 'salary' in fetched).toBe(false);
  });

  it('updates an existing job on conflict', async () => {
    const job = jobFixture();
    await store.saveJob(job);

    const updated: Job = { ...job, title: 'Senior Backend Engineer', status: 'active', version: 2 };
    await store.saveJob(updated);

    expect(await store.getJob(job.id)).toEqual(updated);
  });

  it('lists jobs filtered by source, status, employmentType and company', async () => {
    const greenhouseJob = jobFixture({
      canonical_url: 'https://boards.greenhouse.io/acme/jobs/1',
      source: 'greenhouse',
      company: 'Acme',
      employment_type: 'full_time',
      status: 'active',
    });
    const leverJob = jobFixture({
      canonical_url: 'https://jobs.lever.co/beta/2',
      source: 'lever',
      company: 'Beta',
      employment_type: 'contract',
      status: 'discovered',
    });
    await store.saveJob(greenhouseJob);
    await store.saveJob(leverJob);

    expect((await store.listJobs({ source: 'greenhouse' })).map((j) => j.id)).toEqual([
      greenhouseJob.id,
    ]);
    expect((await store.listJobs({ status: 'discovered' })).map((j) => j.id)).toEqual([
      leverJob.id,
    ]);
    expect((await store.listJobs({ employmentType: 'contract' })).map((j) => j.id)).toEqual([
      leverJob.id,
    ]);
    expect((await store.listJobs({ company: 'Acme' })).map((j) => j.id)).toEqual([
      greenhouseJob.id,
    ]);
    expect((await store.listJobs()).map((j) => j.id).sort()).toEqual(
      [greenhouseJob.id, leverJob.id].sort(),
    );
  });

  it('deletes a job and reports whether a row was removed', async () => {
    const job = jobFixture();
    await store.saveJob(job);

    expect(await store.deleteJob(randomUUID())).toBe(false);
    expect(await store.deleteJob(job.id)).toBe(true);
    expect(await store.getJob(job.id)).toBeNull();
  });

  it('rolls back all writes when the transaction callback throws', async () => {
    const job = jobFixture();

    await expect(
      store.withTransaction(async (scoped) => {
        await scoped.saveJob(job);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.getJob(job.id)).toBeNull();
  });

  it('commits writes from a successful transaction', async () => {
    const job = jobFixture();

    await store.withTransaction(async (scoped) => {
      await scoped.saveJob(job);
    });

    expect(await store.getJob(job.id)).toEqual(job);
  });
});
