import type { EmploymentType, Job, JobSource, JobStatus } from './job.types';

export const JOBS_STORE = Symbol('JOBS_STORE');

export interface JobListFilter {
  source?: JobSource;
  status?: JobStatus;
  employmentType?: EmploymentType;
  company?: string;
}

/**
 * Persistence boundary for job records.
 */
export interface JobStore {
  withTransaction<T>(operation: (store: JobStore) => Promise<T>): Promise<T>;

  getJob(id: string): Promise<Job | null>;
  listJobs(filter?: JobListFilter): Promise<Job[]>;
  saveJob(job: Job): Promise<Job>;
  deleteJob(id: string): Promise<boolean>;
}
