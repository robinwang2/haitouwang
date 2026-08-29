import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresReviewStore } from '../../src/modules/review';
import type { Review } from '../../src/modules/review';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[review.postgres-store] DATABASE_URL is not set - skipping PostgresReviewStore ' +
      'integration tests. This sandbox has no Docker/Postgres available (see ' +
      'docs/qa/mvp-report.md); set DATABASE_URL to a disposable Postgres instance to exercise ' +
      'the real SQL implementation.',
  );
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/materials',
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

function reviewFixture(userId: string, overrides: Partial<Review> = {}): Review {
  const now = new Date().toISOString();
  const materialId = randomUUID();
  return {
    id: randomUUID(),
    user_id: userId,
    job_id: randomUUID(),
    material_ids: [materialId],
    material_versions: { [materialId]: 1 },
    status: 'queued',
    reviewers: ['ats', 'hard_requirements', 'fact_check', 'naturalness'],
    findings: [],
    recommendation: 'human_review',
    round: 1,
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)('PostgresReviewStore integration', () => {
  let pool: Pool;
  let store: PostgresReviewStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(pool);
    const upSqls = await migrationSql('.up.sql');
    for (const sql of upSqls) {
      await pool.query(sql);
    }
    store = new PostgresReviewStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  it('round-trips a review and enforces user_id scoping in SQL', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const review = reviewFixture(userId);

    const saved = await store.saveReview(review);
    expect(saved).toEqual(review);

    expect(await store.getReview(userId, review.id)).toEqual(review);
    expect(await store.getReview(otherUserId, review.id)).toBeUndefined();
    expect((await store.listReviews(userId)).map((row) => row.id)).toEqual([review.id]);
    expect(await store.listReviews(otherUserId)).toEqual([]);
  });

  it('rejects a duplicate review id', async () => {
    const userId = randomUUID();
    const review = reviewFixture(userId);
    await store.saveReview(review);
    await expect(store.saveReview(review)).rejects.toThrow();
  });

  it('updates a review only when the WHERE clause matches the owning tenant', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const review = reviewFixture(userId);
    await store.saveReview(review);
    const updated: Review = {
      ...review,
      status: 'approved',
      recommendation: 'approve',
      version: 2,
    };

    await store.updateReview(otherUserId, updated);
    expect(await store.getReview(userId, review.id)).toEqual(review);

    await store.updateReview(userId, updated);
    expect(await store.getReview(userId, review.id)).toEqual(updated);
  });

  it('rolls back all writes when the transaction callback throws', async () => {
    const userId = randomUUID();
    const review = reviewFixture(userId);

    await expect(
      store.withTransaction(async (scoped) => {
        await scoped.saveReview(review);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.getReview(userId, review.id)).toBeUndefined();
  });
});
