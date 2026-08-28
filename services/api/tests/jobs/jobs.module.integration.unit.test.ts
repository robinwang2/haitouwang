import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JobService } from '../../src/modules/jobs/job.service';
import { JobsModule } from '../../src/modules/jobs/jobs.module';
import type { JobImportDocument } from '../../src/modules/jobs/job.types';

// This suite requires a live Postgres so it can also exercise the
// "DATABASE_URL missing" failure path against the same environment used for
// the happy path below.
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[jobs.module.integration] DATABASE_URL is not set - skipping JobsModule integration tests. ' +
      'Set DATABASE_URL to a disposable Postgres instance to exercise the real module wiring.',
  );
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/jobs',
);

// Dedicated to this suite only: job.postgres-store.unit.test.ts owns the
// default `public` schema (it drops and recreates `public.jobs` around its
// own tests). Running both suites' schema setup against the same table in
// parallel vitest workers is inherently racy ("relation jobs does not
// exist"), so this suite creates and owns an entirely separate Postgres
// schema instead of sharing `public`, and never touches `public.jobs`.
const SCHEMA_NAME = 'jobs_module_integration_test';

async function migrationUpSql(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.up.sql'))
    .sort();
  return Promise.all(files.map((file) => readFile(path.join(MIGRATIONS_DIR, file), 'utf8')));
}

// Appends a libpq `options=-c search_path=...` parameter to the connection
// string so every session opened from the resulting URL - both this file's
// own verification pool and the pg.Pool that PostgresJobStore builds from
// process.env.DATABASE_URL - resolves unqualified `jobs` to
// `jobs_module_integration_test.jobs` instead of `public.jobs`.
function withDedicatedSchema(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const searchPathOption = `-c search_path=${SCHEMA_NAME}`;
  const existingOptions = url.searchParams.get('options');
  url.searchParams.set(
    'options',
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption,
  );
  return url.toString();
}

function backendDocument(): JobImportDocument {
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
    },
  };
}

describe.skipIf(!DATABASE_URL)('JobsModule integration', () => {
  let scopedDatabaseUrl: string;
  let verificationPool: Pool;
  let moduleRef: TestingModule | undefined;

  async function compileJobsModule(): Promise<TestingModule> {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scopedDatabaseUrl;
    try {
      return await Test.createTestingModule({ imports: [JobsModule] }).compile();
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }

  beforeAll(async () => {
    scopedDatabaseUrl = withDedicatedSchema(DATABASE_URL as string);
    verificationPool = new Pool({ connectionString: scopedDatabaseUrl });
    await verificationPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    await verificationPool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    const upSqls = await migrationUpSql();
    for (const sql of upSqls) {
      await verificationPool.query(sql);
    }
  });

  afterAll(async () => {
    await verificationPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    await verificationPool.end();
  });

  beforeEach(async () => {
    await verificationPool.query('TRUNCATE TABLE jobs');
  });

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined;
    }
  });

  it('fails to compile the module when DATABASE_URL is not set', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      await expect(Test.createTestingModule({ imports: [JobsModule] }).compile()).rejects.toThrow(
        /DATABASE_URL is not set/,
      );
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('resolves a JobService backed by PostgresJobStore and persists imported jobs to Postgres', async () => {
    moduleRef = await compileJobsModule();
    const jobService = moduleRef.get(JobService);
    expect(jobService).toBeInstanceOf(JobService);

    const now = '2026-08-27T00:00:00.000Z';
    const imported = await jobService.importJobs([backendDocument()], { now });
    expect(imported).toHaveLength(1);
    const [job] = imported;
    expect(job.title).toBe('Backend Engineer');
    expect(job.version).toBe(1);

    const fetched = await jobService.getJob(job.id);
    expect(fetched).toEqual(job);

    const listed = await jobService.listJobs();
    expect(listed.map((entry) => entry.id)).toEqual([job.id]);

    // Bypass JobService/PostgresJobStore entirely and query the same
    // dedicated schema directly with a fresh pg client, so a passing test
    // can only mean the row actually landed in Postgres (not an in-memory
    // fallback that happens to satisfy JobService's own read path).
    const { rows } = await verificationPool.query<{
      id: string;
      title: string;
      company: string;
      version: number;
    }>('SELECT id, title, company, version FROM jobs WHERE id = $1', [job.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: job.id,
      title: 'Backend Engineer',
      company: 'Acme Corp',
      version: 1,
    });
  });

  it('does not leave a row behind for an id that was never imported', async () => {
    moduleRef = await compileJobsModule();
    const jobService = moduleRef.get(JobService);

    const unknownId = randomUUID();
    expect(await jobService.getJob(unknownId)).toBeNull();

    const { rows } = await verificationPool.query('SELECT id FROM jobs WHERE id = $1', [
      unknownId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
