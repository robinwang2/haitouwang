import { renderMaterialDocumentText, type Material, type MaterialClaim } from '../materials';
import type { Fact } from '../profile';

import type {
  RequiredReviewer,
  ResourceRef,
  ReviewContext,
  ReviewerAgent,
  ReviewerExecutionConfiguration,
  ReviewerFindingDraft,
  ReviewerReport,
} from './review.types';

const ATS_MARKUP = /<\/?[a-z][^>]*>/iu;
const ATS_TABLE = /^\s*\|.+\|\s*$/mu;
const PLACEHOLDER =
  /\{\{[^{}\r\n]+\}\}|\[\[[^\]\r\n]+\]\]|\[(?:placeholder|insert|your\s+)[^\]\r\n]*\]|\b(?:TBD|TODO)\b/iu;
const MODEL_VOICE = /\b(?:as an ai language model|i cannot browse|delve into)\b/iu;

abstract class DeterministicReviewer implements ReviewerAgent {
  public abstract readonly reviewer: RequiredReviewer;

  public async review(
    context: ReviewContext,
    configuration: ReviewerExecutionConfiguration,
  ): Promise<ReviewerReport> {
    return {
      reviewer: this.reviewer,
      configuration_id: configuration.configuration_id,
      findings: this.inspect(context),
    };
  }

  protected abstract inspect(context: ReviewContext): ReviewerFindingDraft[];
}

export class AtsReviewer extends DeterministicReviewer {
  public readonly reviewer = 'ats' as const;

  protected inspect(context: ReviewContext): ReviewerFindingDraft[] {
    const findings: ReviewerFindingDraft[] = [];
    for (const material of context.materials) {
      if (
        ATS_MARKUP.test(material.document.plain_text) ||
        ATS_TABLE.test(material.document.plain_text) ||
        hasUnsafeControlCharacter(material.document.plain_text)
      ) {
        findings.push(
          finding(
            'must_fix',
            'ats_unsafe_structure',
            'Markup, control characters, or table-like layout can prevent reliable ATS parsing.',
            [materialRef(material)],
            'auto_revision',
          ),
        );
      }
      if (PLACEHOLDER.test(material.document.plain_text)) {
        findings.push(
          finding(
            'must_fix',
            'unresolved_placeholder',
            'The material contains a placeholder that must be resolved before approval.',
            [materialRef(material)],
            'must_fix',
          ),
        );
      }
    }
    return findings;
  }
}

export class HardRequirementsReviewer extends DeterministicReviewer {
  public readonly reviewer = 'hard_requirements' as const;

  protected inspect(context: ReviewContext): ReviewerFindingDraft[] {
    const findings: ReviewerFindingDraft[] = [];
    const jobEvidence: ResourceRef[] = [jobRef(context)];
    inspectJobEligibility(context, findings);
    if (
      !context.job.title.trim() ||
      !context.job.company.trim() ||
      context.job.description_status === 'missing'
    ) {
      findings.push(
        finding(
          'must_fix',
          'critical_job_data_missing',
          'The job title, company, or job description is missing, so hard requirements cannot be verified.',
          jobEvidence,
          'human_review',
        ),
      );
    } else if (context.job.description_status === 'partial') {
      findings.push(
        finding(
          'warning',
          'job_description_incomplete',
          'The job description is partial; a person must confirm the omitted hard requirements.',
          jobEvidence,
          'human_review',
        ),
      );
    }

    const requiredKinds = context.required_material_kinds ?? ['resume'];
    for (const kind of requiredKinds) {
      if (!context.materials.some((material) => material.kind === kind)) {
        findings.push(
          finding(
            'must_fix',
            'required_material_missing',
            `A required ${kind} material is missing from this application.`,
            jobEvidence,
            'must_fix',
          ),
        );
      }
    }

    const activeSkillNames = new Set(
      context.facts
        .filter((fact) => fact.kind === 'skill' && isUsableFact(fact, context))
        .map((fact) => normalize(fact.value.name)),
    );
    const unverifiedSkills = context.requirements.required_skills.filter(
      (skill) => !activeSkillNames.has(normalize(skill)),
    );
    if (unverifiedSkills.length > 0) {
      findings.push(
        finding(
          'must_fix',
          'required_qualification_unverified',
          `No confirmed fact supports required skill(s): ${unverifiedSkills.join(', ')}.`,
          jobEvidence,
          'human_review',
        ),
      );
    }

    const authorizations = context.facts
      .filter((fact) => fact.kind === 'work_authorization' && isUsableFact(fact, context))
      .sort(compareFacts);
    const authorizationStates = new Set(
      authorizations.flatMap((authorization) => authorizationStatesForFact(authorization)),
    );
    const authorizationEvidence = [jobRef(context), ...authorizations.map(factRef)];

    if (authorizationStates.size > 1) {
      findings.push(
        finding(
          'must_fix',
          'evidence_conflict',
          'Confirmed work-authorization facts contain incompatible values and require human resolution.',
          authorizationEvidence,
          'human_review',
        ),
      );
    } else if (context.requirements.work_authorization !== 'not_required') {
      if (authorizations.length === 0) {
        findings.push(
          finding(
            'must_fix',
            'work_authorization_missing',
            'A confirmed work-authorization fact is required to evaluate this job.',
            jobEvidence,
            'human_review',
          ),
        );
      } else if (
        [...authorizationStates].some(
          (status) => status !== 'authorized' && status !== 'requires_sponsorship',
        )
      ) {
        findings.push(
          finding(
            'must_fix',
            'work_authorization_unclear',
            'The confirmed work-authorization evidence is unknown or restricted to manual use.',
            authorizationEvidence,
            'human_review',
          ),
        );
      } else if (
        context.requirements.work_authorization === 'sponsorship_unavailable' &&
        authorizationStates.has('requires_sponsorship')
      ) {
        findings.push(
          finding(
            'must_fix',
            'work_authorization_conflict',
            'The confirmed work-authorization evidence conflicts with the job requirement.',
            authorizationEvidence,
            'human_review',
          ),
        );
      }
    }
    return findings;
  }
}

function inspectJobEligibility(context: ReviewContext, findings: ReviewerFindingDraft[]): void {
  const jobEvidence = [jobRef(context)];
  if (context.job.status === 'expired' || context.job.status === 'removed') {
    findings.push(
      finding(
        'must_fix',
        'job_unavailable',
        'The job is expired or removed and cannot be approved for application.',
        jobEvidence,
        'human_review',
      ),
    );
    return;
  }

  if (context.job.status === 'discovered' || context.job.status === 'normalized') {
    findings.push(
      finding(
        'must_fix',
        'job_status_unverified',
        'The job has not reached active status and requires human confirmation.',
        jobEvidence,
        'human_review',
      ),
    );
  }

  if (
    context.job.status === 'risk_review' ||
    context.job.risk.requires_manual_review ||
    context.job.risk.level === 'medium' ||
    context.job.risk.level === 'high' ||
    context.job.risk.level === 'unknown'
  ) {
    findings.push(
      finding(
        'must_fix',
        'job_risk_requires_review',
        'The job status or risk assessment requires a person to review the position before approval.',
        jobEvidence,
        'human_review',
      ),
    );
  }
}

export class FactCheckReviewer extends DeterministicReviewer {
  public readonly reviewer = 'fact_check' as const;

  protected inspect(context: ReviewContext): ReviewerFindingDraft[] {
    const findings: ReviewerFindingDraft[] = [];
    const facts = new Map(context.facts.map((fact) => [fact.id, fact]));
    for (const material of context.materials) {
      if (material.document.plain_text !== renderMaterialDocumentText(material.document)) {
        findings.push(
          finding(
            'must_fix',
            'fabricated_document_text',
            'Rendered material text contains content that is not represented by traceable claims.',
            [materialRef(material)],
            'must_fix',
          ),
        );
      }
      for (const claim of material.document.claims) {
        const materialEvidence = [materialRef(material)];
        if (claim.status === 'pending_confirmation') {
          findings.push(
            finding(
              'must_fix',
              'critical_claim_unconfirmed',
              `Claim ${claim.id} is still pending confirmation.`,
              materialEvidence,
              'must_fix',
            ),
          );
          continue;
        }
        if (claim.citations.length === 0) {
          findings.push(
            finding(
              'must_fix',
              'fabricated_claim',
              `Claim ${claim.id} has no fact evidence.`,
              materialEvidence,
              'must_fix',
            ),
          );
          continue;
        }
        inspectClaim(context, material, claim, facts, findings);
      }
    }
    return findings;
  }
}

export class NaturalnessReviewer extends DeterministicReviewer {
  public readonly reviewer = 'naturalness' as const;

  protected inspect(context: ReviewContext): ReviewerFindingDraft[] {
    const findings: ReviewerFindingDraft[] = [];
    for (const material of context.materials) {
      const text = material.document.plain_text;
      if (MODEL_VOICE.test(text)) {
        findings.push(
          finding(
            'warning',
            'model_voice',
            'The material contains model-like meta language that reads unnaturally.',
            [materialRef(material)],
            'auto_revision',
          ),
        );
      }
      const sentences = text
        .split(/[.!?。！？\r\n]+/u)
        .map((sentence) => normalize(sentence))
        .filter((sentence) => sentence.length >= 20);
      if (new Set(sentences).size < sentences.length) {
        findings.push(
          finding(
            'warning',
            'repetitive_language',
            'A sentence is repeated verbatim, which makes the material sound formulaic.',
            [materialRef(material)],
            'auto_revision',
          ),
        );
      }
    }
    return findings;
  }
}

export function createDefaultReviewers(): ReviewerAgent[] {
  return [
    new AtsReviewer(),
    new HardRequirementsReviewer(),
    new FactCheckReviewer(),
    new NaturalnessReviewer(),
  ];
}

function inspectClaim(
  context: ReviewContext,
  material: Material,
  claim: MaterialClaim,
  facts: ReadonlyMap<string, Fact>,
  findings: ReviewerFindingDraft[],
): void {
  const citedFacts: Fact[] = [];
  const values: string[] = [];
  let invalid = false;
  for (const citation of claim.citations) {
    const fact = facts.get(citation.fact_id);
    if (!fact || fact.user_id !== context.user_id) {
      invalid = true;
      findings.push(
        finding(
          'must_fix',
          'fabricated_claim',
          `Claim ${claim.id} cites a fact that is absent from the authorized evidence set.`,
          [materialRef(material)],
          'must_fix',
        ),
      );
      continue;
    }
    citedFacts.push(fact);
    if (!isUsableFact(fact, context) || fact.version !== citation.fact_version) {
      invalid = true;
      findings.push(
        finding(
          'must_fix',
          'fact_contradiction',
          `Claim ${claim.id} cites a stale, unconfirmed, expired, or disallowed fact version.`,
          [materialRef(material), factRef(fact)],
          'must_fix',
        ),
      );
      continue;
    }
    const field = parseClaimPath(citation.claim_path);
    const rawValue = field === undefined ? undefined : fact.value[field];
    if (rawValue === undefined || rawValue === null || String(rawValue).trim().length === 0) {
      invalid = true;
      findings.push(
        finding(
          'must_fix',
          'fabricated_claim',
          `Claim ${claim.id} points to an absent fact value.`,
          [materialRef(material), factRef(fact)],
          'must_fix',
        ),
      );
      continue;
    }
    values.push(String(rawValue).trim());
  }

  if (new Set(values).size > 1 && values.length > 1) {
    findings.push(
      finding(
        'must_fix',
        'evidence_conflict',
        `Claim ${claim.id} is supported by conflicting fact values and cannot be revised automatically.`,
        [materialRef(material), ...citedFacts.map(factRef)],
        'human_review',
      ),
    );
    return;
  }
  if (!invalid && claim.text !== values.join(' | ')) {
    findings.push(
      finding(
        'must_fix',
        'fabricated_claim',
        `Claim ${claim.id} adds or changes information that is not present in its cited facts.`,
        [materialRef(material), ...citedFacts.map(factRef)],
        'must_fix',
      ),
    );
  }
}

function finding(
  severity: ReviewerFindingDraft['severity'],
  category: string,
  message: string,
  evidenceRefs: ResourceRef[],
  disposition: ReviewerFindingDraft['disposition'],
): ReviewerFindingDraft {
  return {
    severity,
    category,
    message,
    evidence_refs: uniqueRefs(evidenceRefs),
    disposition,
  };
}

function isUsableFact(fact: Fact, context: ReviewContext): boolean {
  if (
    fact.user_id !== context.user_id ||
    fact.status !== 'active' ||
    !fact.confirmed_at ||
    fact.scope.use === 'manual_only' ||
    fact.scope.use === 'prohibited'
  ) {
    return false;
  }
  if (
    fact.scope.use === 'selected_goals' &&
    (!context.goal_id || !fact.scope.goal_ids?.includes(context.goal_id))
  ) {
    return false;
  }
  const evaluatedAt = Date.parse(context.evaluated_at);
  if (!Number.isFinite(evaluatedAt)) return false;
  if (fact.valid_from && Date.parse(fact.valid_from) > evaluatedAt) return false;
  if (fact.valid_until && Date.parse(fact.valid_until) <= evaluatedAt) return false;
  return true;
}

function parseClaimPath(path: string): string | undefined {
  const match = /^value\.([^.[\]]+)$/u.exec(path);
  return match?.[1];
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
}

function authorizationStatesForFact(fact: Fact): string[] {
  const statuses = new Set<string>();
  if (typeof fact.value.status === 'string') {
    statuses.add(normalize(fact.value.status).replace(/[\s-]+/gu, '_'));
  }
  if (typeof fact.value.authorized === 'boolean') {
    statuses.add(fact.value.authorized ? 'authorized' : 'requires_sponsorship');
  }
  if (typeof fact.value.requires_sponsorship === 'boolean') {
    statuses.add(fact.value.requires_sponsorship ? 'requires_sponsorship' : 'authorized');
  }
  return statuses.size > 0 ? [...statuses] : ['unknown'];
}

function compareFacts(left: Fact, right: Fact): number {
  return left.id.localeCompare(right.id) || left.version - right.version;
}

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
}

function jobRef(context: ReviewContext): ResourceRef {
  return { type: 'job', id: context.job.id, version: context.job.version };
}

function materialRef(material: Material): ResourceRef {
  return { type: 'material', id: material.id, version: material.version };
}

function factRef(fact: Fact): ResourceRef {
  return { type: 'fact', id: fact.id, version: fact.version };
}

function uniqueRefs(refs: readonly ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}:${ref.version ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
