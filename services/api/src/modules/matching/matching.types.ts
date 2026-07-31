import type { Job } from '../jobs';
import type { Fact, Goal } from '../profile';

export const MATCHING_WEIGHTS = {
  skills: 25,
  experience: 20,
  work_authorization: 15,
  location: 15,
  salary: 10,
  employment_type: 10,
  preference: 5,
} as const;

export type ScoreDimensionName = keyof typeof MATCHING_WEIGHTS;
export type HardGateName =
  | 'work_authorization'
  | 'blacklist'
  | 'duplicate'
  | 'location'
  | 'salary'
  | 'employment_type'
  | 'risk';
export type HardGateResult = 'pass' | 'block' | 'manual';
export type MatchingDecision = 'eligible' | 'blocked' | 'manual_review';
export type MatchBand = 'exceptional' | 'high' | 'worth_applying' | 'review' | 'low';

export interface ScoreDimension {
  name: ScoreDimensionName;
  weight: (typeof MATCHING_WEIGHTS)[ScoreDimensionName];
  score: number;
  evidence_paths: string[];
}

export interface HardGate {
  name: HardGateName;
  result: HardGateResult;
  evidence_paths: string[];
}

export interface MatchingScore {
  id: string;
  user_id: string;
  goal_id: string;
  job_id: string;
  total: number;
  dimensions: ScoreDimension[];
  hard_gates: HardGate[];
  decision: MatchingDecision;
  explanations: string[];
  input_version: string;
  created_at: string;
}

export type JobWorkAuthorization =
  'not_required' | 'sponsorship_available' | 'sponsorship_unavailable' | 'unknown';

/**
 * Structured requirements produced by a deterministic parser or a
 * user-confirmed review. Free-form model judgments are deliberately not part
 * of the matching input.
 */
export interface JobMatchingRequirements {
  required_skills: string[];
  experience_keywords: string[];
  work_authorization: JobWorkAuthorization;
  preference_keywords?: string[];
}

export interface MatchingContext {
  blacklisted_companies: string[];
  blacklisted_title_keywords: string[];
  already_applied_job_ids: string[];
}

export interface MatchingInput {
  user_id: string;
  goal: Goal;
  job: Job;
  facts: Fact[];
  requirements: JobMatchingRequirements;
  context: MatchingContext;
  /**
   * The caller supplies the clock so fact validity and output timestamps are
   * deterministic under fixture replay and worker retries.
   */
  evaluated_at: string;
}

export class MatchingInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MatchingInputError';
  }
}
