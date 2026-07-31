import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { recognizeApplicationForm } from './form-recognition.js';
import type {
  ApplicationPage,
  CanonicalField,
  ConfirmationGrant,
  ConfirmationVerifier,
  FillOutcome,
  LocalApplicationData,
  ManualIntervention,
  ManualReason,
  PageInspection,
  Preview,
  RecoveryAction,
  SubmissionOutcome,
} from './types.js';

const RECOVERY_ACTIONS: Readonly<Record<ManualReason, RecoveryAction>> = {
  captcha: 'user_complete_locally',
  assessment: 'user_complete_locally',
  video_interview: 'user_complete_locally',
  electronic_signature: 'user_complete_locally',
  unknown_required_field: 'user_answer_required',
  legal_or_identity_question: 'user_answer_required',
  work_authorization_ambiguous: 'user_answer_required',
  page_structure_changed: 'user_complete_locally',
  submission_result_uncertain: 'verify_submission_result',
  credential_required: 'user_complete_locally',
  policy_blocked: 'review_policy',
};

function manual(manualReason: ManualReason): ManualIntervention {
  return {
    state: 'manual_intervention_required',
    status: 'manual_intervention_required',
    manualReason,
    recoveryAction: RECOVERY_ACTIONS[manualReason],
  };
}

function stableInspectionHash(inspection: PageInspection): string {
  const shape = inspection.controls
    .map((control) => ({
      id: control.id,
      kind: control.kind,
      name: control.name,
      label: control.label,
      required: control.required,
      disabled: control.disabled,
      visible: control.visible,
      options: [...control.options],
      accept: control.accept,
      valuePresent: control.valuePresent,
      stateDigest: control.stateDigest,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return createHash('sha256')
    .update(JSON.stringify({ url: inspection.url, platform: inspection.platform, shape }))
    .digest('hex');
}

async function validMaterialPath(materialPath: string): Promise<string | undefined> {
  const resolved = path.resolve(materialPath);
  try {
    const materialStat = await stat(resolved);
    return materialStat.isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export class LocalApplicationRunner {
  constructor(
    private readonly page: ApplicationPage,
    private readonly confirmationVerifier: ConfirmationVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fill(data: LocalApplicationData): Promise<FillOutcome> {
    let initialInspection: PageInspection;
    try {
      initialInspection = await this.page.inspect();
    } catch {
      return manual('page_structure_changed');
    }
    const recognition = recognizeApplicationForm(initialInspection);
    if (recognition.manualReason) return manual(recognition.manualReason);
    if (!recognition.platform) return manual('page_structure_changed');

    const valueActions: Array<{
      field: CanonicalField;
      control: (typeof recognition.fields)[number]['control'];
      value: NonNullable<LocalApplicationData['answers'][CanonicalField]>;
    }> = [];
    const uploadActions: Array<{
      field: 'resume' | 'cover_letter';
      control: (typeof recognition.fields)[number]['control'];
      path: string;
    }> = [];

    for (const recognized of recognition.fields) {
      if (recognized.field === 'resume' || recognized.field === 'cover_letter') {
        const materialPath = data.materials[recognized.field];
        if (!materialPath) {
          if (recognized.control.required) return manual('unknown_required_field');
          continue;
        }
        const resolved = await validMaterialPath(materialPath);
        if (!resolved) return manual('unknown_required_field');
        uploadActions.push({
          field: recognized.field,
          control: recognized.control,
          path: resolved,
        });
        continue;
      }

      const answer = data.answers[recognized.field];
      if (answer === undefined || answer === '') {
        if (recognized.control.required) return manual('unknown_required_field');
        continue;
      }
      valueActions.push({ field: recognized.field, control: recognized.control, value: answer });
    }

    let finalInspection: PageInspection;
    try {
      for (const action of valueActions) {
        await this.page.setValue({ control: action.control, value: action.value });
      }
      for (const action of uploadActions) {
        await this.page.upload({ control: action.control, path: action.path });
      }
      finalInspection = await this.page.inspect();
    } catch {
      return manual('page_structure_changed');
    }
    const finalRecognition = recognizeApplicationForm(finalInspection);
    if (finalRecognition.manualReason) return manual(finalRecognition.manualReason);
    if (finalRecognition.platform !== recognition.platform) return manual('page_structure_changed');

    const preview: Preview = {
      hash: stableInspectionHash(finalInspection),
      platform: recognition.platform,
      filledFields: [...new Set(valueActions.map((action) => action.field))].sort(),
      uploadedMaterials: [...new Set(uploadActions.map((action) => action.field))].sort(),
    };

    return { state: 'awaiting_confirmation', status: 'paused', preview };
  }

  async submit(preview: Preview, grant?: ConfirmationGrant): Promise<SubmissionOutcome> {
    if (!grant || grant.previewHash !== preview.hash) return manual('policy_blocked');
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      return manual('policy_blocked');
    }
    try {
      if (!(await this.confirmationVerifier.verify(grant))) return manual('policy_blocked');
    } catch {
      return manual('policy_blocked');
    }

    let inspection: PageInspection;
    try {
      inspection = await this.page.inspect();
    } catch {
      return manual('page_structure_changed');
    }
    const recognition = recognizeApplicationForm(inspection);
    if (recognition.manualReason) return manual(recognition.manualReason);
    if (stableInspectionHash(inspection) !== preview.hash) return manual('page_structure_changed');

    try {
      if (!(await this.confirmationVerifier.consume(grant))) return manual('policy_blocked');
    } catch {
      return manual('policy_blocked');
    }

    try {
      const observation = await this.page.submitOnce();
      if (observation.kind === 'uncertain') return manual('submission_result_uncertain');
      return {
        state: 'completed',
        status: 'completed',
        confirmationNumber: observation.confirmationNumber,
        evidenceDigest: observation.evidenceDigest,
      };
    } catch {
      // A transport or page error may occur after the click. Never retry the submission.
      return manual('submission_result_uncertain');
    }
  }
}
