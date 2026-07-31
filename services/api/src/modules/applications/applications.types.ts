export type ApplicationStatus =
  | 'draft'
  | 'materials_ready'
  | 'approved'
  | 'queued'
  | 'filling'
  | 'awaiting_confirmation'
  | 'submitted_pending_verification'
  | 'manual_required'
  | 'submitted'
  | 'interview'
  | 'rejected'
  | 'offer'
  | 'withdrawn'
  | 'cancelled';

export type ManualReason =
  | 'captcha'
  | 'assessment'
  | 'video_interview'
  | 'electronic_signature'
  | 'unknown_required_field'
  | 'legal_or_identity_question'
  | 'work_authorization_ambiguous'
  | 'page_structure_changed'
  | 'submission_result_uncertain'
  | 'credential_required'
  | 'policy_blocked'
  | 'evidence_conflict';

export interface Actor {
  type: 'user' | 'agent' | 'service' | 'system';
  id: string;
}

export interface ResourceRef {
  type:
    | 'user'
    | 'goal'
    | 'fact'
    | 'file'
    | 'material'
    | 'job'
    | 'score'
    | 'review'
    | 'agent'
    | 'application'
    | 'task'
    | 'notification'
    | 'interview'
    | 'metric';
  id: string;
  version?: number;
}

export interface SubmissionEvidence {
  type:
    | 'confirmation_number'
    | 'redacted_screenshot'
    | 'success_page_fingerprint'
    | 'manual_attestation';
  reference?: string;
  captured_at: string;
  target_origin: string;
  verified: boolean;
}

export interface TimelineEntry {
  id: string;
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus;
  actor: Actor;
  occurred_at: string;
  reason_code: string;
  evidence_ref?: ResourceRef;
}

export interface Application {
  id: string;
  user_id: string;
  job_id: string;
  goal_id: string;
  material_ids: string[];
  status: ApplicationStatus;
  submission_idempotency_key: string;
  evidence: SubmissionEvidence[];
  timeline: TimelineEntry[];
  deadline_at?: string;
  manual_reason?: ManualReason;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateApplicationRequest {
  job_id: string;
  goal_id: string;
  material_ids: string[];
  submission_idempotency_key: string;
  deadline_at?: string;
}

export interface MutationContext {
  actor: Actor;
  idempotency_key: string;
  request_id?: string;
  correlation_id?: string;
}

export interface TransitionPrerequisites {
  materials_approved?: boolean;
  no_open_must_fix?: boolean;
  preview_ready?: boolean;
  confirmation_verified?: boolean;
}

export interface ApplicationTransitionRequest {
  to_status: ApplicationStatus;
  reason_code: string;
  confirmation_token?: string;
  evidence?: SubmissionEvidence[];
  manual_reason?: ManualReason;
}

export interface TransitionContext extends MutationContext {
  expected_version: number;
  prerequisites?: TransitionPrerequisites;
}

export interface ApplicationListFilter {
  statuses?: ApplicationStatus[];
  job_id?: string;
  goal_id?: string;
  due_before?: string;
  overdue_at?: string;
  has_manual_task?: boolean;
}

export interface BoardColumn {
  status: ApplicationStatus;
  applications: Application[];
}

export interface ApplicationBoard {
  columns: BoardColumn[];
  total: number;
}

export interface ManualAnswerRef {
  field: string;
  answer_ref: ResourceRef;
}

export interface CreateManualTaskRequest {
  target_url: string;
  material_refs: ResourceRef[];
  answer_refs: ManualAnswerRef[];
  risk_codes: string[];
  unresolved_items: string[];
  manual_reason: ManualReason;
  recovery_action:
    | 'user_complete_locally'
    | 'user_answer_required'
    | 're_pair_agent'
    | 'verify_submission_result'
    | 'review_policy';
  deadline_at?: string;
}

export interface ManualApplicationTask {
  id: string;
  user_id: string;
  type: 'manual_application';
  status: 'requires_human' | 'queued' | 'cancelled' | 'succeeded';
  resource: ResourceRef;
  attempt: 0;
  max_attempts: 1;
  manual_reason: ManualReason;
  package: {
    target_url: string;
    material_refs: ResourceRef[];
    answer_refs: ManualAnswerRef[];
    risk_codes: string[];
    unresolved_items: string[];
    recovery_action: CreateManualTaskRequest['recovery_action'];
    deadline_at?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface AgentApplicationReceipt {
  receipt_id: string;
  agent_id: string;
  command_id: string;
  sequence: number;
  application_id: string;
  command_type: 'fill_application' | 'prepare_preview' | 'submit_application';
  status:
    'accepted' | 'started' | 'paused' | 'completed' | 'rejected' | 'manual_intervention_required';
  occurred_at: string;
  manual_reason?: ManualReason;
  confirmation_verified?: boolean;
  target_origin?: string;
  result_verified?: boolean;
  result?: {
    confirmation_number?: string;
    evidence_file_id?: string;
    preview_hash?: string;
  };
}

export interface RecordedApplicationReceipt {
  receipt_id: string;
  application: Application;
  replayed: boolean;
}

export interface ApplicationAuditEvent {
  event_id: string;
  occurred_at: string;
  actor: Actor;
  action: string;
  resource: ResourceRef;
  outcome: 'succeeded' | 'rejected' | 'manual_intervention';
  from_status?: ApplicationStatus | null;
  to_status?: ApplicationStatus;
  reason_code?: string;
  replayed_from_event_id?: string;
}

export interface ApplicationServiceOptions {
  clock?: { now(): Date };
  id_factory?: () => string;
}
