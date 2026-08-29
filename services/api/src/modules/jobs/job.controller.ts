import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import { BearerAuthGuard } from '../../common/auth.guard';
import { httpError } from '../../common/http-error';
import { JobService } from './job.service';
import type { Job, JobStatus } from './job.types';

const JOB_STATUSES = new Set<string>([
  'discovered',
  'normalized',
  'risk_review',
  'active',
  'expired',
  'removed',
]);

interface PageMeta {
  page_size: number;
  next_cursor: string | null;
  total_estimate: number;
}

interface JobPage {
  items: Job[];
  page: PageMeta;
}

/**
 * Jobs are a global resource (no user_id column on jobs_*), so this route reads
 * through JobService without any tenant filtering. BearerAuthGuard still applies -
 * an unauthenticated caller gets 401 - but a valid token from any tenant may list jobs.
 */
@Controller('v1')
@UseGuards(BearerAuthGuard)
export class JobController {
  public constructor(
    @Inject(JobService)
    private readonly jobs: JobService,
  ) {}

  @Get('jobs')
  public async listJobs(
    @Query('cursor') cursor: string | undefined,
    @Query('page_size') pageSizeParam: string | undefined,
    @Query('status') status: string | undefined,
  ): Promise<JobPage> {
    const pageSize = this.parsePageSize(pageSizeParam);
    if (status !== undefined && !JOB_STATUSES.has(status)) {
      throw httpError(400, 'VALIDATION_FAILED', 'status is invalid.');
    }
    const jobs = await this.jobs.listJobs({ status: status as JobStatus | undefined });
    return this.paginate(jobs, cursor, pageSize);
  }

  private parsePageSize(value: string | undefined): number {
    if (value === undefined) return 25;
    const pageSize = Number(value);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw httpError(400, 'VALIDATION_FAILED', 'page_size must be an integer from 1 to 100.');
    }
    return pageSize;
  }

  private paginate(items: Job[], cursor: string | undefined, pageSize: number): JobPage {
    let start = 0;
    if (cursor !== undefined) {
      const index = items.findIndex((item) => item.id === cursor);
      if (index < 0) {
        throw httpError(400, 'VALIDATION_FAILED', 'cursor is invalid for this result set.');
      }
      start = index + 1;
    }
    const page = items.slice(start, start + pageSize);
    return {
      items: page,
      page: {
        page_size: pageSize,
        next_cursor: start + page.length < items.length ? (page.at(-1)?.id ?? null) : null,
        total_estimate: items.length,
      },
    };
  }
}
