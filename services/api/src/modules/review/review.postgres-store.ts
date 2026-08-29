import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { ReviewStore } from './review-store.interface';
import type {
  RequiredReviewer,
  Review,
  ReviewFinding,
  ReviewRecommendation,
  ReviewStatus,
} from './review.types';

type Executor = Pool | PoolClient;

interface ReviewRow extends QueryResultRow {
  review_id: string;
  user_id: string;
  job_id: string;
  material_ids: string[];
  material_versions: Record<string, number>;
  status: ReviewStatus;
  reviewers: RequiredReviewer[];
  findings: ReviewFinding[];
  recommendation: ReviewRecommendation;
  round: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function mapReview(row: ReviewRow): Review {
  return {
    id: row.review_id,
    user_id: row.user_id,
    job_id: row.job_id,
    material_ids: row.material_ids,
    material_versions: row.material_versions,
    status: row.status,
    reviewers: row.reviewers,
    findings: row.findings,
    recommendation: row.recommendation,
    round: row.round,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    Boolean(error) && typeof error === 'object' && (error as { code?: string }).code === '23505'
  );
}

/**
 * Postgres-backed implementation of ReviewStore. Every statement scopes its WHERE
 * clause by user_id; row-level tenant isolation is enforced in SQL. Instances returned
 * from withTransaction share one client/transaction.
 */
export class PostgresReviewStore implements ReviewStore {
  constructor(
    readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  async withTransaction<T>(operation: (store: ReviewStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresReviewStore(this.pool, client);
      const result = await operation(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveReview(review: Review): Promise<Review> {
    try {
      await this.executor.query(
        `INSERT INTO review_records (
           review_id, user_id, job_id, material_ids, material_versions, status,
           reviewers, findings, recommendation, round, version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          review.id,
          review.user_id,
          review.job_id,
          review.material_ids,
          JSON.stringify(review.material_versions),
          review.status,
          review.reviewers,
          JSON.stringify(review.findings),
          review.recommendation,
          review.round,
          review.version,
          review.created_at,
          review.updated_at,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Review id already exists: ${review.id}`, { cause: error });
      }
      throw error;
    }
    return review;
  }

  async updateReview(userId: string, review: Review): Promise<void> {
    await this.executor.query(
      `UPDATE review_records SET
         job_id = $3,
         material_ids = $4,
         material_versions = $5,
         status = $6,
         reviewers = $7,
         findings = $8,
         recommendation = $9,
         round = $10,
         version = $11,
         updated_at = $12
       WHERE review_id = $1 AND user_id = $2`,
      [
        review.id,
        userId,
        review.job_id,
        review.material_ids,
        JSON.stringify(review.material_versions),
        review.status,
        review.reviewers,
        JSON.stringify(review.findings),
        review.recommendation,
        review.round,
        review.version,
        review.updated_at,
      ],
    );
  }

  async getReview(userId: string, reviewId: string): Promise<Review | undefined> {
    const { rows } = await this.executor.query<ReviewRow>(
      'SELECT * FROM review_records WHERE review_id = $1 AND user_id = $2',
      [reviewId, userId],
    );
    return rows[0] ? mapReview(rows[0]) : undefined;
  }

  async listReviews(userId: string): Promise<Review[]> {
    const { rows } = await this.executor.query<ReviewRow>(
      'SELECT * FROM review_records WHERE user_id = $1 ORDER BY review_id',
      [userId],
    );
    return rows.map(mapReview);
  }
}
