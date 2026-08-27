import { Module } from '@nestjs/common';
import { Pool } from 'pg';

import { JOBS_STORE } from './job-store.interface';
import type { JobStore } from './job-store.interface';
import { JobService } from './job.service';
import { PostgresJobStore } from './job.postgres-store';

function createJobStore(): JobStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. JobsModule requires PostgreSQL as the single source of truth ' +
        'and will not silently fall back to an in-memory store. Set DATABASE_URL to start this module.',
    );
  }
  const pool = new Pool({ connectionString });
  return new PostgresJobStore(pool);
}

@Module({
  providers: [{ provide: JOBS_STORE, useFactory: createJobStore }, JobService],
  exports: [JobService],
})
export class JobsModule {}
