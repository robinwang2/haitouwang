export const AGENT_SCOPES = [
  'agent:commands:claim',
  'agent:receipts:write',
  'agent:heartbeat:write',
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export type AgentCapability =
  'greenhouse_fill' | 'lever_fill' | 'file_upload' | 'preview' | 'submit_after_confirmation';

export interface PublicKeyJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid?: string;
}

export interface CreatePairingSessionRequest {
  requested_scopes: AgentScope[];
}

export interface PairingSessionCreated {
  pairing_session_id: string;
  pairing_secret: string;
  pairing_uri: string;
  display_code: string;
  challenge: string;
  expires_at: string;
}

export interface ClaimPairingSessionRequest {
  pairing_secret: string;
  device_name: string;
  agent_version?: string;
  platform?: 'windows' | 'macos' | 'linux';
  public_key_jwk: PublicKeyJwk;
  challenge_signature: string;
}

export interface PairingClaimed {
  pairing_session_id: string;
  status: 'claimed';
  device_name: string;
  public_key_thumbprint: string;
  display_code: string;
  expires_at: string;
}

export interface ConfirmPairingSessionRequest {
  display_code: string;
  public_key_thumbprint: string;
  approved: true;
}

export type AgentStatus = 'unpaired' | 'pairing' | 'online' | 'offline' | 'revoked';

export interface Agent {
  id: string;
  user_id: string;
  device_name: string;
  public_key_thumbprint: string;
  status: AgentStatus;
  scopes: AgentScope[];
  authorization_version: number;
  last_seen_at?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PairingConfirmed {
  agent: Agent;
  authorization_code: string;
  authorization_code_expires_at: string;
}

export type AgentTokenRequest =
  | {
      grant_type: 'authorization_code';
      agent_id: string;
      authorization_code: string;
    }
  | {
      grant_type: 'refresh_token';
      agent_id: string;
      refresh_token: string;
    };

export interface AgentTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
  authorization_version: number;
}

export interface AgentRequestAuthentication {
  access_token: string;
  nonce: string;
  proof: string;
  idempotency_key: string;
}

export interface AgentProofAuthentication {
  nonce: string;
  proof: string;
  idempotency_key: string;
}

export interface ClaimCommandRequest {
  capabilities: AgentCapability[];
  wait_seconds: number;
}

export type AgentCommandType =
  'fill_application' | 'prepare_preview' | 'submit_application' | 'cancel_task';

export interface AgentCommandPayload {
  task_id: string;
  application_id?: string;
  target_url?: string;
  material_file_ids?: string[];
  answer_fact_ids?: string[];
  preview_hash?: string;
}

export interface AgentCommand {
  command_id: string;
  type: AgentCommandType;
  idempotency_key: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  resource: {
    type: 'application' | 'task';
    id: string;
    version: number;
  };
  payload: AgentCommandPayload;
  confirmation_token?: string;
  signature: string;
}

export type ReceiptStatus =
  'accepted' | 'started' | 'paused' | 'completed' | 'rejected' | 'manual_intervention_required';

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

export interface CommandReceiptRequest {
  sequence: number;
  status: ReceiptStatus;
  occurred_at: string;
  manual_reason?: ManualReason;
  result?: {
    confirmation_number?: string;
    evidence_file_id?: string;
    preview_hash?: string;
  };
}

export interface CommandReceipt {
  receipt_id: string;
  agent_id: string;
  command_id: string;
  sequence: number;
  status: ReceiptStatus;
  recorded_at: string;
}

export interface HeartbeatRequest {
  agent_version: string;
  status: 'online' | 'busy' | 'paused';
  capabilities: AgentCapability[];
  authorization_version: number;
  current_command_id?: string;
  observed_at: string;
}

export interface QueueAgentCommandRequest {
  agent_id: string;
  user_id: string;
  tenant_id: string;
  type: AgentCommandType;
  idempotency_key: string;
  expires_at: string;
  resource: AgentCommand['resource'];
  payload: AgentCommandPayload;
  confirmation_token?: string;
}

export interface WebUserPrincipal {
  user_id: string;
  tenant_id: string;
}

export type AgentErrorCode =
  | 'AUTH_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'FORBIDDEN'
  | 'TOKEN_SCOPE_INSUFFICIENT'
  | 'RESOURCE_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CREDENTIAL_DATA_FORBIDDEN'
  | 'CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'REPLAY_DETECTED'
  | 'PAIRING_CODE_INVALID'
  | 'INTERNAL_ERROR';

export interface AgentAuditRecord {
  occurred_at: string;
  action: string;
  result: 'accepted' | 'rejected';
  reason?: AgentErrorCode;
  agent_id?: string;
  pairing_session_id?: string;
  public_key_thumbprint?: string;
  user_id?: string;
  tenant_id?: string;
}

export interface AgentClock {
  now(): Date;
}

export interface AgentServiceOptions {
  clock?: AgentClock;
  pairing_ttl_seconds?: number;
  authorization_code_ttl_seconds?: number;
  access_token_ttl_seconds?: number;
  refresh_token_ttl_seconds?: number;
  issuer?: string;
  audience?: string;
  pairing_uri_origin?: string;
  signing_key?: Uint8Array;
}
