import { Inject, Injectable } from '@nestjs/common';

import { JOBS_STORE } from './job-store.interface';
import type { JobListFilter, JobStore } from './job-store.interface';
import { runJobImportPipeline } from './job.pipeline';
import type { Job, JobImportDocument, JobImportOptions } from './job.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function contentFingerprint(job: Job): string {
  const { version: _version, updated_at: _updatedAt, ...content } = job;
  return JSON.stringify(stableValue(content));
}

@Injectable()
export class JobService {
  constructor(
    @Inject(JOBS_STORE)
    private readonly store: JobStore,
  ) {}

  async importJobs(documents: JobImportDocument[], options: JobImportOptions): Promise<Job[]> {
    const parsed = runJobImportPipeline(documents, options);
    return this.store.withTransaction(async (store) => {
      const merged: Job[] = [];
      for (const job of parsed) {
        merged.push(await this.mergeJob(store, job, options.now));
      }
      return merged;
    });
  }

  async getJob(id: string): Promise<Job | null> {
    return this.store.getJob(id);
  }

  async listJobs(filter?: JobListFilter): Promise<Job[]> {
    return this.store.listJobs(filter);
  }

  private async mergeJob(store: JobStore, incoming: Job, now: string): Promise<Job> {
    const existing = await store.getJob(incoming.id);
    if (!existing) {
      return store.saveJob(clone(incoming));
    }
    if (contentFingerprint(existing) === contentFingerprint(incoming)) {
      return existing;
    }
    const updated: Job = {
      ...clone(incoming),
      version: existing.version + 1,
      updated_at: now,
    };
    return store.saveJob(updated);
  }
}
