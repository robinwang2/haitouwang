export type Uuid = string;

export type GoalStatus = 'active' | 'paused' | 'archived';
export type EmploymentType =
  'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary' | 'other';
export type WorkAuthorizationRule =
  'authorized' | 'requires_sponsorship' | 'unknown' | 'manual_only';

export interface MoneyRange {
  currency: string;
  minimum?: number;
  maximum?: number;
  period?: 'hour' | 'month' | 'year';
}

export interface Goal {
  id: Uuid;
  user_id: Uuid;
  name: string;
  title_keywords: string[];
  locations: string[];
  employment_types: EmploymentType[];
  salary?: MoneyRange;
  work_authorization_rule?: WorkAuthorizationRule;
  locale?: string;
  status: GoalStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateGoalInput {
  name: string;
  title_keywords: string[];
  locations: string[];
  employment_types: EmploymentType[];
  salary?: MoneyRange;
  work_authorization_rule?: WorkAuthorizationRule;
  locale?: string;
  status: Exclude<GoalStatus, 'archived'>;
}

export type UpdateGoalInput = Partial<Omit<CreateGoalInput, 'status'> & { status: GoalStatus }>;

export type FactKind =
  | 'identity'
  | 'contact'
  | 'summary'
  | 'experience'
  | 'education'
  | 'skill'
  | 'certification'
  | 'project'
  | 'work_authorization'
  | 'preference';
export type FactStatus =
  'pending_confirmation' | 'active' | 'expired' | 'rejected' | 'revoked' | 'prohibited' | 'deleted';
export type FactScopeUse = 'all_goals' | 'selected_goals' | 'manual_only' | 'prohibited';
export type FactValue = Record<string, string | number | boolean | null>;

export interface FactScope {
  use: FactScopeUse;
  goal_ids?: Uuid[];
}

export interface SourceRef {
  type: 'user' | 'file' | 'system_rule';
  reference: string;
}

export interface Fact {
  id: Uuid;
  user_id: Uuid;
  kind: FactKind;
  value: FactValue;
  scope: FactScope;
  status: FactStatus;
  valid_from?: string;
  valid_until?: string;
  source: SourceRef;
  confirmed_at?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateFactInput {
  kind: FactKind;
  value: FactValue;
  scope: FactScope;
  source: SourceRef;
  valid_from?: string;
  valid_until?: string;
  user_confirmed?: boolean;
}

export type UpdateFactInput = Partial<
  Pick<Fact, 'value' | 'scope' | 'source' | 'valid_from' | 'valid_until'>
>;

export type FilePurpose =
  | 'resume_source'
  | 'resume_output'
  | 'cover_letter'
  | 'portfolio'
  | 'transcript'
  | 'application_evidence'
  | 'other';
export type FileMediaType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain'
  | 'image/png'
  | 'image/jpeg';
export type FileScanStatus = 'pending' | 'clean' | 'quarantined' | 'infected' | 'failed';

export interface FileMetadata {
  id: Uuid;
  user_id: Uuid;
  purpose: FilePurpose;
  display_name: string;
  media_type: FileMediaType;
  byte_size: number;
  sha256: string;
  scan_status: FileScanStatus;
  version: number;
  created_at: string;
}

export interface CreateFileMetadataInput {
  purpose: FilePurpose;
  display_name: string;
  media_type: FileMediaType;
  byte_size: number;
  sha256: string;
  scan_status?: FileScanStatus;
}

export interface MutationContext {
  actor_id: Uuid;
  request_id: string;
  correlation_id: string;
  idempotency_key: string;
  causation_id?: string;
}

export interface AuditEvent {
  event_id: Uuid;
  occurred_at: string;
  actor: { type: 'user' | 'system'; id: string };
  action: string;
  resource: { type: 'user' | 'goal' | 'fact' | 'file'; id: Uuid; version?: number };
  outcome: 'succeeded' | 'rejected' | 'failed' | 'manual_intervention';
  tenant_id: Uuid;
  request_id: string;
  correlation_id: string;
  causation_id?: string;
  from_status?: string | null;
  to_status?: string | null;
  changed_fields: string[];
  reason_code?: string;
  replayed_from_event_id?: Uuid;
}

export interface VersionRecord<T> {
  resource_id: Uuid;
  version: number;
  recorded_at: string;
  snapshot: T;
}

export interface FactListFilter {
  status?: FactStatus;
  kind?: FactKind;
  include_deleted?: boolean;
}

export interface ProfileExport {
  schema_version: '1.0.0';
  exported_at: string;
  user_id: Uuid;
  goals: Goal[];
  facts: Fact[];
  files: FileMetadata[];
  audit: AuditEvent[];
}
