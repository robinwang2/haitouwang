export type DashboardPageState = 'loading' | 'ready' | 'empty' | 'error' | 'permission' | 'paused';

export type Agent = {
  id: string;
  user_id: string;
  device_name: string;
  public_key_thumbprint: string;
  status: 'unpaired' | 'pairing' | 'online' | 'offline' | 'revoked';
  scopes: Array<'agent:commands:claim' | 'agent:receipts:write' | 'agent:heartbeat:write'>;
  authorization_version: number;
  last_seen_at?: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  user_id: string;
  type:
    | 'import_job'
    | 'score_job'
    | 'generate_material'
    | 'review_application'
    | 'fill_application'
    | 'submit_application'
    | 'manual_application'
    | 'send_notification'
    | 'sync_email'
    | 'build_interview_pack';
  status: 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'requires_human' | 'cancelled' | 'expired';
  resource: {
    type: 'user' | 'goal' | 'fact' | 'file' | 'material' | 'job' | 'score' | 'review' | 'agent' | 'application' | 'task' | 'notification' | 'interview' | 'metric';
    id: string;
    version?: number;
  };
  attempt: number;
  max_attempts: number;
  manual_reason?:
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
  created_at: string;
  updated_at: string;
};

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

export type Application = {
  id: string;
  user_id: string;
  job_id: string;
  goal_id: string;
  material_ids: string[];
  status: ApplicationStatus;
  submission_idempotency_key: string;
  evidence: Array<{
    type: 'confirmation_number' | 'redacted_screenshot' | 'success_page_fingerprint' | 'manual_attestation';
    reference?: string;
    captured_at: string;
    target_origin: string;
    verified: boolean;
  }>;
  timeline: Array<{
    id: string;
    from_status: string | null;
    to_status: string;
    actor: { type: 'user' | 'service' | 'agent' | 'system'; id: string };
    occurred_at: string;
    reason_code: string;
  }>;
  deadline_at?: string;
  manual_reason?: Task['manual_reason'];
  version: number;
  created_at: string;
  updated_at: string;
};

export type DashboardCapabilities = {
  canView: boolean;
  canOperateAgent: boolean;
};
