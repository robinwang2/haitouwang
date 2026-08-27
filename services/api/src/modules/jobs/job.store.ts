import { Injectable } from '@nestjs/common';

import type { JobListFilter, JobStore } from './job-store.interface';
import type { Job } from './job.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

@Injectable()
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();

  async withTransaction<T>(operation: (store: JobStore) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async getJob(id: string): Promise<Job | null> {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  async listJobs(filter: JobListFilter = {}): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          (!filter.source || job.source === filter.source) &&
          (!filter.status || job.status === filter.status) &&
          (!filter.employmentType || job.employment_type === filter.employmentType) &&
          (!filter.company || job.company === filter.company),
      )
      .sort(this.byCreatedAt)
      .map(clone);
  }

  async saveJob(job: Job): Promise<Job> {
    const saved = clone(job);
    this.jobs.set(saved.id, saved);
    return clone(saved);
  }

  async deleteJob(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }

  private byCreatedAt(left: Job, right: Job): number {
    return `${left.created_at}:${left.id}`.localeCompare(`${right.created_at}:${right.id}`);
  }
}
