import type { Fact, FileMetadata, SourceRef } from '../profile';

export const MATERIAL_KINDS = ['resume', 'cover_letter', 'open_question_answer'] as const;
export type GeneratedMaterialKind = (typeof MATERIAL_KINDS)[number];
export type MaterialStatus =
  'draft' | 'generating' | 'review_required' | 'approved' | 'rejected' | 'failed' | 'superseded';

export interface MaterialFactCitation {
  fact_id: string;
  fact_version: number;
  claim_path: string;
}

export interface MaterialClaim {
  id: string;
  text: string;
  status: 'verified' | 'pending_confirmation';
  citations: MaterialFactCitation[];
}

export interface MaterialSection {
  key: string;
  heading?: string;
  claim_ids: string[];
}

export interface MaterialDocument {
  title?: string;
  preamble?: string[];
  sections: MaterialSection[];
  claims: MaterialClaim[];
  closing?: string[];
  plain_text: string;
}

export type MaterialCheckCode =
  | 'CLAIM_NOT_TRACEABLE'
  | 'FACT_NOT_ALLOWED'
  | 'FACT_VERSION_MISMATCH'
  | 'FACT_PATH_INVALID'
  | 'FACT_TEXT_ALTERED'
  | 'PENDING_CONFIRMATION'
  | 'PLACEHOLDER_REMAINS'
  | 'WORD_COUNT_BELOW_MINIMUM'
  | 'WORD_COUNT_ABOVE_MAXIMUM'
  | 'ATS_UNSAFE_CONTENT'
  | 'DUPLICATE_CLAIM_ID'
  | 'UNREFERENCED_CLAIM'
  | 'DOCUMENT_TEXT_MISMATCH';

export interface MaterialCheckIssue {
  code: MaterialCheckCode;
  severity: 'blocking' | 'warning';
  message: string;
  claim_id?: string;
  fact_id?: string;
}

export interface MaterialChecks {
  word_count: number;
  character_count: number;
  ats_compatible: boolean;
  has_placeholders: boolean;
  publishable: boolean;
  issues: MaterialCheckIssue[];
}

export interface MaterialGenerationCost {
  strategy: 'deterministic_fact_template';
  external_model_calls: 0;
  input_characters: number;
  output_characters: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
}

export interface Material {
  id: string;
  user_id: string;
  job_id?: string;
  kind: GeneratedMaterialKind;
  status: MaterialStatus;
  version: number;
  file_ids: string[];
  fact_citations: MaterialFactCitation[];
  supersedes_id?: string;
  document: MaterialDocument;
  checks: MaterialChecks;
  generation: MaterialGenerationCost;
  created_at: string;
  updated_at: string;
}

export interface PendingMaterialClaimInput {
  text: string;
}

export interface MaterialFormatConstraints {
  minimum_words?: number;
  maximum_words?: number;
}

export interface GenerateMaterialInput {
  id?: string;
  user_id: string;
  job_id?: string;
  goal_id?: string;
  kind: GeneratedMaterialKind;
  facts: readonly Fact[];
  fact_ids?: readonly string[];
  evaluated_at: string;
  locale?: string;
  base_resume_id?: string;
  resume_files?: readonly FileMetadata[];
  open_question?: string;
  pending_claims?: readonly PendingMaterialClaimInput[];
  constraints?: MaterialFormatConstraints;
}

export interface ReviseMaterialInput extends Omit<
  GenerateMaterialInput,
  'id' | 'user_id' | 'job_id' | 'kind'
> {
  pending_claims?: readonly PendingMaterialClaimInput[];
}

export interface ClaimEvidence {
  citation: MaterialFactCitation;
  source: SourceRef;
  value: string;
}

export type MaterialDiffOperation = 'equal' | 'insert' | 'delete';

export interface MaterialDiffLine {
  operation: MaterialDiffOperation;
  text: string;
}

export interface MaterialDiff {
  from: { id: string; version: number };
  to: { id: string; version: number };
  added_claim_ids: string[];
  removed_claim_ids: string[];
  changed_claim_ids: string[];
  lines: MaterialDiffLine[];
}

export type MaterialExportFormat = 'text' | 'docx' | 'pdf';

export interface MaterialExport {
  format: MaterialExportFormat;
  media_type:
    | 'text/plain'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    | 'application/pdf';
  filename: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface MaterialAuditEvent {
  event_id: string;
  user_id: string;
  material_id: string;
  material_version: number;
  action:
    | 'material.draft_created'
    | 'material.draft_revised'
    | 'material.approved'
    | 'material.rejected'
    | 'material.superseded'
    | 'material.exported';
  occurred_at: string;
  changed_fields: string[];
}
