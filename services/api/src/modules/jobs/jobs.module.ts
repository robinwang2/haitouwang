import { Module } from '@nestjs/common';

import { AuthService } from '../../auth.service';
import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { JOBS_STORE } from './job-store.interface';
import type { JobStore } from './job-store.interface';
import { JobController } from './job.controller';
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
  controllers: [JobController],
  providers: [
    { provide: JOBS_STORE, useFactory: createJobStore },
    JobService,
    // BearerAuthGuard (used by JobController) depends on AuthService. AppModule also
    // provides AuthService, but Nest module DI is not ambient across sibling imports, so
    // this module needs its own instance; AuthService is stateless (reads env at
    // construction only), so a second instance is safe.
    AuthService,
  ],
  exports: [JobService],
})
export class JobsModule {}
