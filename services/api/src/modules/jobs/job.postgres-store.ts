import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import type { JobListFilter, JobStore } from './job-store.interface';
import type {
  DescriptionStatus,
  EmploymentType,
  Job,
  JobRisk,
  JobSource,
  JobSourceRef,
  JobStatus,
  MoneyRange,
} from './job.types';

type Executor = Pool | PoolClient;

interface JobRow extends QueryResultRow {
  id: string;
  canonical_url: string;
  source: JobSource;
  source_refs: JobSourceRef[];
  title: string;
  company: string;
  location: string;
  employment_type: EmploymentType;
  salary: MoneyRange | null;
  description_status: DescriptionStatus;
  risk: JobRisk;
  status: JobStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    canonical_url: row.canonical_url,
    source: row.source,
    source_refs: row.source_refs,
    title: row.title,
    company: row.company,
    location: row.location,
    employment_type: row.employment_type,
    description_status: row.description_status,
    risk: row.risk,
    status: row.status,
    version: row.version,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.salary ? { salary: row.salary } : {}),
  };
}

/**
 * Postgres-backed implementation of JobStore. Jobs are not tenant-scoped (no
 * user_id column), unlike ProfileStore, so statements filter only on the
 * caller-supplied JobListFilter. Instances returned from withTransaction
 * share one client/transaction.
 */
export class PostgresJobStore implements JobStore {
  constructor(
    readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  async withTransaction<T>(operation: (store: JobStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresJobStore(this.pool, client);
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

  async getJob(id: string): Promise<Job | null> {
    const { rows } = await this.executor.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async listJobs(filter: JobListFilter = {}): Promise<Job[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.source) {
      params.push(filter.source);
      conditions.push(`source = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.employmentType) {
      params.push(filter.employmentType);
      conditions.push(`employment_type = $${params.length}`);
    }
    if (filter.company) {
      params.push(filter.company);
      conditions.push(`company = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await this.executor.query<JobRow>(
      `SELECT * FROM jobs ${where} ORDER BY created_at, id`,
      params,
    );
    return rows.map(mapJob);
  }

  async saveJob(job: Job): Promise<Job> {
    await this.executor.query(
      `INSERT INTO jobs (
         id, canonical_url, source, source_refs, title, company, location,
         employment_type, salary, description_status, risk, status, version,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         canonical_url = EXCLUDED.canonical_url,
         source = EXCLUDED.source,
         source_refs = EXCLUDED.source_refs,
         title = EXCLUDED.title,
         company = EXCLUDED.company,
         location = EXCLUDED.location,
         employment_type = EXCLUDED.employment_type,
         salary = EXCLUDED.salary,
         description_status = EXCLUDED.description_status,
         risk = EXCLUDED.risk,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at`,
      [
        job.id,
        job.canonical_url,
        job.source,
        JSON.stringify(job.source_refs),
        job.title,
        job.company,
        job.location,
        job.employment_type,
        job.salary ? JSON.stringify(job.salary) : null,
        job.description_status,
        JSON.stringify(job.risk),
        job.status,
        job.version,
        job.created_at,
        job.updated_at,
      ],
    );
    return job;
  }

  async deleteJob(id: string): Promise<boolean> {
    const result = await this.executor.query('DELETE FROM jobs WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
