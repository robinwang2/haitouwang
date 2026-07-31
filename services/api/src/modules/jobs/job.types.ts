export const JOB_SOURCES = ['greenhouse', 'lever', 'company_careers', 'manual_url'] as const;

export type JobSource = (typeof JOB_SOURCES)[number];

export type EmploymentType =
  'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary' | 'other' | 'unknown';

export type DescriptionStatus = 'complete' | 'partial' | 'missing';
export type JobRiskLevel = 'low' | 'medium' | 'high' | 'unknown';
export type JobStatus =
  'discovered' | 'normalized' | 'risk_review' | 'active' | 'expired' | 'removed';

export interface MoneyRange {
  minimum?: number;
  maximum?: number;
  currency: string;
  period?: 'hour' | 'month' | 'year';
}

export interface JobSourceRef {
  type: JobSource;
  reference: string;
  captured_at: string;
  content_hash: string;
}

export interface JobRisk {
  level: JobRiskLevel;
  reasons: string[];
  requires_manual_review: boolean;
}

export interface Job {
  id: string;
  canonical_url: string;
  source: JobSource;
  source_refs: JobSourceRef[];
  title: string;
  company: string;
  location: string;
  employment_type: EmploymentType;
  salary?: MoneyRange;
  description_status: DescriptionStatus;
  risk: JobRisk;
  status: JobStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * A fetched response passed to the deterministic import pipeline. Fetching and
 * authentication stay outside the module so raw site credentials can never
 * enter a job record or event payload.
 */
export interface JobImportDocument {
  source: JobSource;
  url: string;
  payload: unknown;
  fetched_at: string;
  /**
   * Greenhouse and Lever posting responses do not consistently carry a
   * display company name. Their connector must supply its configured company.
   */
  company?: string;
}

export interface JobImportOptions {
  /**
   * Explicit clock input used for validThrough/closed-at decisions. Requiring
   * it keeps fixture replays and worker retries deterministic.
   */
  now: string;
}

export class JobImportError extends Error {
  public constructor(
    message: string,
    public readonly source: JobSource,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'JobImportError';
  }
}
