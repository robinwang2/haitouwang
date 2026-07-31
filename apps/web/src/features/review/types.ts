export type ReviewStatus =
  | 'queued'
  | 'running'
  | 'requires_changes'
  | 'needs_human'
  | 'approved'
  | 'rejected'
  | 'failed';

export type FindingSeverity = 'info' | 'warning' | 'must_fix';
export type FindingStatus = 'open' | 'resolved' | 'accepted_risk';
export type ReviewerName =
  | 'ats'
  | 'hard_requirements'
  | 'matching'
  | 'skeptical_recruiter'
  | 'hiring_manager'
  | 'fact_check'
  | 'naturalness';

export type MaterialKind = 'resume' | 'cover_letter' | 'open_question';
export type DifferenceKind = 'added' | 'removed' | 'changed';
export type EvidenceState = 'confirmed' | 'pending' | 'disputed';

export interface EvidenceRef {
  readonly type: 'fact' | 'material' | 'job' | 'review' | 'file';
  readonly id: string;
  readonly version?: number;
}

export interface ReviewFinding {
  readonly id: string;
  readonly reviewer: ReviewerName;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly message: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status: FindingStatus;
  readonly resolution?: string;
}

export interface FactEvidence {
  readonly id: string;
  readonly label: string;
  readonly sourceLabel: string;
  readonly version: number;
  readonly allowed: boolean;
  readonly allowedScope: string;
  readonly state: EvidenceState;
}

export interface MaterialStatement {
  readonly id: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export interface MaterialDifference {
  readonly id: string;
  readonly kind: DifferenceKind;
  readonly before?: string;
  readonly after?: string;
}

export interface ReviewMaterial {
  readonly id: string;
  readonly kind: MaterialKind;
  readonly label: string;
  readonly version: number;
  readonly statements: readonly MaterialStatement[];
  readonly differences: readonly MaterialDifference[];
  readonly updatedAt: string;
}

export interface ReviewerResult {
  readonly reviewer: ReviewerName;
  readonly status: 'queued' | 'running' | 'completed' | 'failed';
  readonly summary?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ReviewQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly required: boolean;
  readonly answer?: string;
  readonly evidenceId?: string;
  readonly confirmationAnswer?: string;
}

export interface ReviewCase {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly companyName: string;
  readonly hardRequirements: readonly string[];
  readonly status: ReviewStatus;
  readonly recommendation: 'approve' | 'revise' | 'reject' | 'human_review';
  readonly round: number;
  readonly version: number;
  readonly materials: readonly ReviewMaterial[];
  readonly evidence: readonly FactEvidence[];
  readonly findings: readonly ReviewFinding[];
  readonly reviewerResults: readonly ReviewerResult[];
  readonly questions: readonly ReviewQuestion[];
  readonly updatedAt: string;
}

export interface ReviewCapabilities {
  readonly canViewFacts: boolean;
  readonly canEdit: boolean;
  readonly canDecide: boolean;
}

export type ReviewPageState = 'ready' | 'loading' | 'empty' | 'error' | 'permission_denied';

export interface Actor {
  readonly type: 'user' | 'agent' | 'service' | 'system';
  readonly id: string;
}

export interface AuditEvent {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly occurred_at: string;
  readonly actor: Actor;
  readonly action:
    | 'review.material_edited'
    | 'review.finding_resolved'
    | 'review.question_answered'
    | 'review.approved'
    | 'review.rejected';
  readonly resource: { readonly type: 'review'; readonly id: string; readonly version: number };
  readonly outcome: 'succeeded' | 'rejected' | 'failed';
  readonly reason_code?: string;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly changed_fields: readonly string[];
  readonly from_status?: string | null;
  readonly to_status?: string | null;
}

export interface CommandContext {
  readonly actor: Actor;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface DecisionResult {
  readonly accepted: boolean;
  readonly review: ReviewCase;
  readonly auditEvent: AuditEvent;
  readonly error?: string;
}

export interface ReviewDecisionGateway {
  saveMaterialEdit(
    review: ReviewCase,
    materialId: string,
    statementId: string,
    text: string,
    context: CommandContext,
  ): Promise<DecisionResult>;
  resolveFinding(
    review: ReviewCase,
    findingId: string,
    resolution: string,
    context: CommandContext,
  ): Promise<DecisionResult>;
  answerQuestion(
    review: ReviewCase,
    questionId: string,
    answer: string,
    context: CommandContext,
  ): Promise<DecisionResult>;
  approve(review: ReviewCase, capabilities: ReviewCapabilities, context: CommandContext): Promise<DecisionResult>;
  reject(review: ReviewCase, reason: string, note: string, capabilities: ReviewCapabilities, context: CommandContext): Promise<DecisionResult>;
}
