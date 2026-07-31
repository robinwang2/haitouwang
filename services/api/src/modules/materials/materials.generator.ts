import type { Fact, FactKind, FileMetadata } from '../profile';

import { MaterialsError } from './materials.errors';
import {
  renderMaterialDocumentText,
  selectAllowedFacts,
  type FactPolicyContext,
} from './materials.policy';
import type {
  GenerateMaterialInput,
  MaterialClaim,
  MaterialDocument,
  MaterialGenerationCost,
  MaterialSection,
} from './materials.types';

const RESUME_ORDER: readonly FactKind[] = [
  'identity',
  'contact',
  'summary',
  'experience',
  'project',
  'education',
  'certification',
  'skill',
  'work_authorization',
  'preference',
];
const LETTER_ORDER: readonly FactKind[] = [
  'identity',
  'summary',
  'experience',
  'project',
  'skill',
  'education',
  'certification',
  'contact',
  'work_authorization',
  'preference',
];
const ANSWER_ORDER: readonly FactKind[] = [
  'summary',
  'experience',
  'project',
  'skill',
  'education',
  'certification',
  'identity',
  'contact',
  'work_authorization',
  'preference',
];

const SECTION_HEADINGS: Readonly<Record<FactKind, string>> = {
  identity: 'Identity',
  contact: 'Contact',
  summary: 'Summary',
  experience: 'Experience',
  education: 'Education',
  skill: 'Skills',
  certification: 'Certifications',
  project: 'Projects',
  work_authorization: 'Work Authorization',
  preference: 'Preferences',
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface GeneratedDraft {
  document: MaterialDocument;
  generation: MaterialGenerationCost;
  file_ids: string[];
  allowed_facts: Fact[];
}

export function generateMaterialDraft(input: GenerateMaterialInput): GeneratedDraft {
  validateGenerationInput(input);
  const context: FactPolicyContext = {
    user_id: input.user_id,
    goal_id: input.goal_id,
    evaluated_at: input.evaluated_at,
  };
  const allowedFacts = selectAllowedFacts(input.facts, input.fact_ids, context);
  const baseResume =
    input.kind === 'resume'
      ? selectBaseResume(input.user_id, input.resume_files ?? [], input.base_resume_id)
      : undefined;

  const claimsByKind = new Map<FactKind, MaterialClaim[]>();
  for (const fact of allowedFacts) {
    const claims = claimsByKind.get(fact.kind) ?? [];
    for (const [field, rawValue] of Object.entries(fact.value).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (rawValue === null || String(rawValue).trim().length === 0) continue;
      claims.push({
        id: claimId(fact, field),
        text: String(rawValue).trim(),
        status: 'verified',
        citations: [
          {
            fact_id: fact.id,
            fact_version: fact.version,
            claim_path: `value.${field}`,
          },
        ],
      });
    }
    claimsByKind.set(fact.kind, claims);
  }

  const order =
    input.kind === 'resume'
      ? RESUME_ORDER
      : input.kind === 'cover_letter'
        ? LETTER_ORDER
        : ANSWER_ORDER;
  const sections: MaterialSection[] = [];
  const claims: MaterialClaim[] = [];
  for (const kind of order) {
    const kindClaims = claimsByKind.get(kind) ?? [];
    if (kindClaims.length === 0) continue;
    sections.push({
      key: kind,
      heading: SECTION_HEADINGS[kind],
      claim_ids: kindClaims.map((claim) => claim.id),
    });
    claims.push(...kindClaims);
  }

  const pendingClaims = input.pending_claims ?? [];
  if (pendingClaims.length > 0) {
    const pending: MaterialClaim[] = pendingClaims.map((claim, index) => {
      if (!claim.text?.trim()) {
        throw new MaterialsError('VALIDATION_FAILED', `pending_claims[${index}].text is required.`);
      }
      return {
        id: `pending:${index + 1}`,
        text: claim.text.trim(),
        status: 'pending_confirmation',
        citations: [],
      };
    });
    sections.push({
      key: 'pending_confirmation',
      heading: 'Pending Confirmation',
      claim_ids: pending.map((claim) => claim.id),
    });
    claims.push(...pending);
  }
  if (claims.filter((claim) => claim.status === 'verified').length > 500) {
    throw new MaterialsError(
      'VALIDATION_FAILED',
      'A material cannot contain more than 500 fact citations.',
    );
  }

  const document = assembleDocument(input, sections, claims);
  let inputCharacters = 0;
  for (const fact of allowedFacts) {
    for (const value of Object.values(fact.value)) {
      inputCharacters += value === null ? 0 : String(value).length;
    }
  }
  return {
    document,
    generation: {
      strategy: 'deterministic_fact_template',
      external_model_calls: 0,
      input_characters: inputCharacters,
      output_characters: document.plain_text.length,
      estimated_input_tokens: estimateTokens(inputCharacters),
      estimated_output_tokens: estimateTokens(document.plain_text.length),
    },
    file_ids: baseResume ? [baseResume.id] : [],
    allowed_facts: allowedFacts,
  };
}

export function selectBaseResume(
  userId: string,
  files: readonly FileMetadata[],
  requestedId?: string,
): FileMetadata | undefined {
  if (!userId.trim()) {
    throw new MaterialsError('VALIDATION_FAILED', 'user_id is required.');
  }
  const candidates = files.filter(
    (file) =>
      file.user_id === userId && file.purpose === 'resume_source' && file.scan_status === 'clean',
  );
  if (requestedId) {
    const requested = candidates.find((file) => file.id === requestedId);
    if (!requested) {
      throw new MaterialsError(
        'RESOURCE_NOT_FOUND',
        'The requested base resume is unavailable or has not passed scanning.',
      );
    }
    return { ...requested };
  }
  return [...candidates].sort(
    (left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) ||
      right.version - left.version ||
      left.id.localeCompare(right.id),
  )[0];
}

function assembleDocument(
  input: GenerateMaterialInput,
  sections: MaterialSection[],
  claims: MaterialClaim[],
): MaterialDocument {
  const title =
    input.kind === 'resume'
      ? 'Resume'
      : input.kind === 'cover_letter'
        ? 'Cover Letter'
        : input.open_question?.trim() || 'Open Question Answer';
  const preamble = input.kind === 'cover_letter' ? ['Dear Hiring Team,'] : undefined;
  const closing = input.kind === 'cover_letter' ? ['Sincerely'] : undefined;
  const document: MaterialDocument = {
    title,
    ...(preamble ? { preamble } : {}),
    sections: sections.map((section) => ({
      ...section,
      claim_ids: [...section.claim_ids],
    })),
    claims: claims.map((claim) => ({
      ...claim,
      citations: claim.citations.map((citation) => ({ ...citation })),
    })),
    ...(closing ? { closing } : {}),
    plain_text: '',
  };
  document.plain_text = renderMaterialDocumentText(document);
  return document;
}

function validateGenerationInput(input: GenerateMaterialInput): void {
  if (!input || !UUID_PATTERN.test(input.user_id ?? '')) {
    throw new MaterialsError('VALIDATION_FAILED', 'user_id must be a UUID.');
  }
  if (!['resume', 'cover_letter', 'open_question_answer'].includes(input.kind)) {
    throw new MaterialsError('VALIDATION_FAILED', 'Unsupported generated material kind.');
  }
  if (!Array.isArray(input.facts)) {
    throw new MaterialsError('VALIDATION_FAILED', 'facts must be an array.');
  }
  for (const [field, value] of [
    ['id', input.id],
    ['job_id', input.job_id],
    ['goal_id', input.goal_id],
    ['base_resume_id', input.base_resume_id],
  ] as const) {
    if (value !== undefined && !UUID_PATTERN.test(value)) {
      throw new MaterialsError('VALIDATION_FAILED', `${field} must be a UUID.`);
    }
  }
  if ((input.fact_ids?.length ?? 0) > 500) {
    throw new MaterialsError('VALIDATION_FAILED', 'fact_ids cannot contain more than 500 items.');
  }
  if (
    input.kind === 'open_question_answer' &&
    input.open_question !== undefined &&
    !input.open_question.trim()
  ) {
    throw new MaterialsError('VALIDATION_FAILED', 'open_question cannot be blank.');
  }
}

function claimId(fact: Fact, field: string): string {
  if (`value.${field}`.length > 256) {
    throw new MaterialsError('VALIDATION_FAILED', 'Fact field path cannot exceed 256 characters.');
  }
  return `${fact.id}:v${fact.version}:${field}`;
}

function estimateTokens(characters: number): number {
  return characters === 0 ? 0 : Math.ceil(characters / 4);
}
