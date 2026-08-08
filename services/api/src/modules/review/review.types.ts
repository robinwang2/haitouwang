import type { Job } from '../jobs';
import type { Material, GeneratedMaterialKind } from '../materials';
import type { JobMatchingRequirements } from '../matching';
import type { Fact } from '../profile';

export const REQUIRED_REVIEWERS = [
  'ats',
  'hard_requirements',
  'fact_check',
  'naturalness',
] as const;

export type RequiredReviewer = (typeof REQUIRED_REVIEWERS)[number];
export type ReviewStatus =
  'queued' | 'running' | 'requires_changes' | 'needs_human' | 'approved' | 'rejected' | 'failed';
export type ReviewRecommendation = 'approve' | 'revise' | 'reject' | 'human_review';
export type FindingSeverity = 'info' | 'warning' | 'must_fix';
export type FindingStatus = 'open' | 'resolved' | 'accepted_risk';
export type FindingDisposition = 'must_fix' | 'auto_revision' | 'human_review';

export interface ResourceRef {
  type: 'fact' | 'material' | 'job' | 'review';
  id: string;
  version?: number;
}

/** Contract-shaped finding. Action routing is kept in ReviewSummary. */
export interface ReviewFinding {
  id: string;
  reviewer: RequiredReviewer;
  severity: FindingSeverity;
  category: string;
  message: string;
  evidence_refs: ResourceRef[];
  status: FindingStatus;
}

/** Contract-shaped Review aggregate; do not add implementation metadata here. */
export interface Review {
  id: string;
  user_id: string;
  job_id: string;
  material_ids: string[];
  /** Immutable material versions evaluated by this Review, keyed by material id. */
  material_versions: Record<string, number>;
  status: ReviewStatus;
  reviewers: RequiredReviewer[];
  findings: ReviewFinding[];
  recommendation: ReviewRecommendation;
  round: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ReviewSummary {
  must_fix: string[];
  auto_revision: string[];
  human_review: string[];
}

export interface ReviewerExecutionConfiguration {
  configuration_id: string;
  provider: string;
  model: string;
  role: 'reviewer';
  reviewer: RequiredReviewer;
}

export interface GeneratorExecutionConfiguration {
  configuration_id: string;
  provider: string;
  model: string;
  role: 'generator';
}

export interface ReviewExecutionConfiguration {
  generator: GeneratorExecutionConfiguration;
  reviewers: Record<RequiredReviewer, ReviewerExecutionConfiguration>;
}

export interface ReviewContext {
  user_id: string;
  goal_id?: string;
  job: Job;
  materials: readonly Material[];
  facts: readonly Fact[];
  requirements: JobMatchingRequirements;
  required_material_kinds?: readonly GeneratedMaterialKind[];
  evaluated_at: string;
}

export interface ReviewRequest extends ReviewContext {
  review_id?: string;
  round?: number;
  execution: ReviewExecutionConfiguration;
}

export interface ReviewerFindingDraft {
  severity: FindingSeverity;
  category: string;
  message: string;
  evidence_refs: ResourceRef[];
  disposition: FindingDisposition;
}

export interface ReviewerReport {
  reviewer: RequiredReviewer;
  configuration_id: string;
  findings: ReviewerFindingDraft[];
}

export interface ReviewerAgent {
  readonly reviewer: RequiredReviewer;
  review(
    context: ReviewContext,
    configuration: ReviewerExecutionConfiguration,
  ): Promise<ReviewerReport>;
}

export interface ReviewOutcome {
  review: Review;
  summary: ReviewSummary;
  reports: ReviewerReport[];
  transitions: ReviewStatus[];
}

export interface AutomaticRevisionAgent {
  readonly configuration: GeneratorExecutionConfiguration;
  revise(
    context: ReviewContext,
    findings: readonly ReviewFinding[],
    nextRound: number,
  ): Promise<ReviewContext>;
}

export interface ReviewCycleOutcome {
  outcome: ReviewOutcome;
  rounds: ReviewOutcome[];
  automatic_revisions: number;
}
