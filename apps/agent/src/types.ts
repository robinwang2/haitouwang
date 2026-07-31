export type SupportedPlatform = 'greenhouse' | 'lever';

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
  | 'policy_blocked';

export type RecoveryAction =
  'user_complete_locally' | 'user_answer_required' | 'verify_submission_result' | 'review_policy';

export type CanonicalField =
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'email'
  | 'phone'
  | 'address'
  | 'city'
  | 'state'
  | 'postal_code'
  | 'country'
  | 'current_company'
  | 'linkedin_url'
  | 'github_url'
  | 'website_url'
  | 'resume'
  | 'cover_letter';

export type AnswerValue = string | boolean | readonly string[];

export interface LocalApplicationData {
  answers: Partial<Record<CanonicalField, AnswerValue>>;
  materials: Partial<Record<'resume' | 'cover_letter', string>>;
}

export type ControlKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'password'
  | 'submit'
  | 'button'
  | 'hidden';

export interface DetectedControl {
  id: string;
  kind: ControlKind;
  name: string;
  label: string;
  required: boolean;
  disabled: boolean;
  visible: boolean;
  options: readonly string[];
  accept?: string;
  valuePresent: boolean;
  /** Keyed, local-only digest of the current value or selected-file state. */
  stateDigest: string;
}

export interface PageInspection {
  url: string;
  platform?: SupportedPlatform;
  controls: readonly DetectedControl[];
  hazards: readonly ManualReason[];
}

export interface ValueAction {
  control: DetectedControl;
  value: AnswerValue;
}

export interface UploadAction {
  control: DetectedControl;
  path: string;
}

export type SubmissionObservation =
  | {
      kind: 'confirmed';
      confirmationNumber?: string;
      evidenceDigest: string;
    }
  | { kind: 'uncertain' };

export interface ApplicationPage {
  inspect(): Promise<PageInspection>;
  setValue(action: ValueAction): Promise<void>;
  upload(action: UploadAction): Promise<void>;
  submitOnce(): Promise<SubmissionObservation>;
}

export interface Preview {
  hash: string;
  platform: SupportedPlatform;
  filledFields: readonly CanonicalField[];
  uploadedMaterials: readonly ('resume' | 'cover_letter')[];
}

export interface AwaitingConfirmation {
  state: 'awaiting_confirmation';
  status: 'paused';
  preview: Preview;
}

export interface ManualIntervention {
  state: 'manual_intervention_required';
  status: 'manual_intervention_required';
  manualReason: ManualReason;
  recoveryAction: RecoveryAction;
}

export type FillOutcome = AwaitingConfirmation | ManualIntervention;

export interface ConfirmationGrant {
  token: string;
  applicationId: string;
  commandId: string;
  previewHash: string;
  expiresAt: string;
}

export interface ConfirmationVerifier {
  verify(grant: ConfirmationGrant): Promise<boolean> | boolean;
  consume(grant: ConfirmationGrant): Promise<boolean> | boolean;
}

export type SubmissionOutcome =
  | {
      state: 'completed';
      status: 'completed';
      confirmationNumber?: string;
      evidenceDigest: string;
    }
  | ManualIntervention;
