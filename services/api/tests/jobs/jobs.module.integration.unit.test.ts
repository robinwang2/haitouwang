import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JobService } from '../../src/modules/jobs/job.service';
import { JobsModule } from '../../src/modules/jobs/jobs.module';
import type { JobImportDocument } from '../../src/modules/jobs/job.types';

// This suite requires a live Postgres so it can also exercise the
// "DATABASE_URL missing" failure path against the same environment used for
// the happy path below (see the first `it`, which temporarily deletes and
// restores process.env.DATABASE_URL). The @nestjs/testing package that would
// normally provide Test.createTestingModule is not a dependency of
// services/api, so this suite boots the module the same way production does
// (NestFactory.createApplicationContext), which exercises the identical
// @Module metadata, provider factory and DI resolution as
// Test.createTestingModule would.
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
  let verificationPool: Pool;
  let app: INestApplicationContext | undefined;

  beforeAll(async () => {
    verificationPool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(verificationPool);
    const upSqls = await migrationSql('.up.sql');
    for (const sql of upSqls) {
      await verificationPool.query(sql);
    }
  });

  afterAll(async () => {
    await resetSchema(verificationPool);
    await verificationPool.end();
  });

  beforeEach(async () => {
    await verificationPool.query('TRUNCATE TABLE jobs');
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('fails to compile the module when DATABASE_URL is not set', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      // abortOnError defaults to true, which makes Nest call process.abort()
      // on an initialization failure instead of rejecting this promise -
      // that would kill the whole test worker rather than let us assert on
      // the rejection, so it must be disabled here.
      await expect(
        NestFactory.createApplicationContext(JobsModule, {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toThrow(/DATABASE_URL is not set/);
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('resolves a JobService backed by PostgresJobStore and persists imported jobs to Postgres', async () => {
    app = await NestFactory.createApplicationContext(JobsModule, {
      logger: false,
      abortOnError: false,
    });
    const jobService = app.get(JobService);
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
    // DATABASE_URL directly with a fresh pg client, so a passing test can
    // only mean the row actually landed in Postgres (not an in-memory
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
    app = await NestFactory.createApplicationContext(JobsModule, {
      logger: false,
      abortOnError: false,
    });
    const jobService = app.get(JobService);

    const unknownId = randomUUID();
    expect(await jobService.getJob(unknownId)).toBeNull();

    const { rows } = await verificationPool.query('SELECT id FROM jobs WHERE id = $1', [
      unknownId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
