import { Module } from '@nestjs/common';

import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { JOBS_STORE } from './job-store.interface';
import type { JobStore } from './job-store.interface';
import { JobService } from './job.service';
import { PostgresJobStore } from './job.postgres-store';

function createJobStore(): JobStore {
  return createLazyPostgresStore<JobStore>(
    'JobsModule',
    {
      withTransaction: true,
      getJob: true,
      listJobs: true,
      saveJob: true,
      deleteJob: true,
    },
    (pool) => new PostgresJobStore(pool),
  );
}

@Module({
  providers: [{ provide: JOBS_STORE, useFactory: createJobStore }, JobService],
  exports: [JobService],
})
export class JobsModule {}
