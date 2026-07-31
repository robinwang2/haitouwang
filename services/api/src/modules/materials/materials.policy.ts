import type { Fact } from '../profile';

import { MaterialsError } from './materials.errors';
import type {
  ClaimEvidence,
  MaterialCheckIssue,
  MaterialChecks,
  MaterialDocument,
  MaterialFactCitation,
  MaterialFormatConstraints,
} from './materials.types';

const PLACEHOLDER =
  /\{\{[^{}\r\n]+\}\}|\[\[[^\]\r\n]+\]\]|\[(?:placeholder|insert|your\s+)[^\]\r\n]*\]|<[^<>\r\n]+>|\b(?:TBD|TODO)\b/iu;
const HTML_MARKUP = /<\/?[a-z][^>]*>/iu;

export interface FactPolicyContext {
  user_id: string;
  goal_id?: string;
  evaluated_at: string;
}

export interface DocumentValidationResult {
  checks: MaterialChecks;
  citations: MaterialFactCitation[];
  evidence: ClaimEvidence[];
}

export function isFactAllowed(fact: Fact, context: FactPolicyContext): boolean {
  if (fact.user_id !== context.user_id) return false;
  if (
    fact.status !== 'active' ||
    !fact.confirmed_at ||
    !Number.isFinite(Date.parse(fact.confirmed_at)) ||
    !Number.isInteger(fact.version) ||
    fact.version < 1
  ) {
    return false;
  }
  if (fact.scope.use === 'manual_only' || fact.scope.use === 'prohibited') return false;
  if (
    fact.scope.use === 'selected_goals' &&
    (!context.goal_id || !fact.scope.goal_ids?.includes(context.goal_id))
  ) {
    return false;
  }

  const evaluatedAt = Date.parse(context.evaluated_at);
  const validFrom = parseOptionalDate(fact.valid_from);
  const validUntil = parseOptionalDate(fact.valid_until);
  if (!Number.isFinite(evaluatedAt) || validFrom === null || validUntil === null) return false;
  return (
    (validFrom === undefined || validFrom <= evaluatedAt) &&
    (validUntil === undefined || validUntil > evaluatedAt)
  );
}

export function selectAllowedFacts(
  facts: readonly Fact[],
  factIds: readonly string[] | undefined,
  context: FactPolicyContext,
): Fact[] {
  validatePolicyContext(context);
  const byId = new Map<string, Fact>();
  for (const fact of facts) {
    if (byId.has(fact.id)) {
      throw new MaterialsError('VALIDATION_FAILED', `Duplicate fact id: ${fact.id}`);
    }
    byId.set(fact.id, fact);
  }

  if (factIds) {
    const requested = new Set<string>();
    for (const id of factIds) {
      if (requested.has(id)) {
        throw new MaterialsError('VALIDATION_FAILED', `Duplicate requested fact id: ${id}`);
      }
      requested.add(id);
      const fact = byId.get(id);
      if (!fact || fact.user_id !== context.user_id) {
        throw new MaterialsError('RESOURCE_NOT_FOUND', `Fact not found: ${id}`);
      }
      if (!isFactAllowed(fact, context)) {
        throw new MaterialsError(
          'FACT_POLICY_VIOLATION',
          `Fact ${id} is not confirmed, current, or allowed for this goal.`,
        );
      }
    }
    return sortFacts([...requested].map((id) => byId.get(id)!));
  }

  return sortFacts(facts.filter((fact) => isFactAllowed(fact, context)));
}

export function validateMaterialDocument(
  document: MaterialDocument,
  facts: readonly Fact[],
  context: FactPolicyContext,
  constraints: MaterialFormatConstraints = {},
): DocumentValidationResult {
  validatePolicyContext(context);
  validateConstraints(constraints);
  const issues: MaterialCheckIssue[] = [];
  const factMap = new Map<string, Fact>();
  for (const fact of facts) {
    if (factMap.has(fact.id)) {
      throw new MaterialsError('VALIDATION_FAILED', `Duplicate fact id: ${fact.id}`);
    }
    factMap.set(fact.id, fact);
  }

  const claims = new Map<string, (typeof document.claims)[number]>();
  const citations = new Map<string, MaterialFactCitation>();
  const evidence: ClaimEvidence[] = [];
  for (const claim of document.claims) {
    if (claims.has(claim.id)) {
      issues.push({
        code: 'DUPLICATE_CLAIM_ID',
        severity: 'blocking',
        message: `Claim id ${claim.id} occurs more than once.`,
        claim_id: claim.id,
      });
      continue;
    }
    claims.set(claim.id, claim);

    if (claim.status === 'pending_confirmation') {
      issues.push({
        code: 'PENDING_CONFIRMATION',
        severity: 'blocking',
        message: 'A pending claim must be confirmed before publication.',
        claim_id: claim.id,
      });
      if (claim.citations.length > 0) {
        issues.push({
          code: 'CLAIM_NOT_TRACEABLE',
          severity: 'blocking',
          message: 'Pending claims cannot present citations as verified evidence.',
          claim_id: claim.id,
        });
      }
      continue;
    }

    if (claim.citations.length === 0) {
      issues.push({
        code: 'CLAIM_NOT_TRACEABLE',
        severity: 'blocking',
        message: 'Every verified claim requires at least one fact citation.',
        claim_id: claim.id,
      });
      continue;
    }

    const claimValues: string[] = [];
    for (const citation of claim.citations) {
      const fact = factMap.get(citation.fact_id);
      if (!fact) {
        issues.push({
          code: 'CLAIM_NOT_TRACEABLE',
          severity: 'blocking',
          message: `Citation fact ${citation.fact_id} was not supplied.`,
          claim_id: claim.id,
          fact_id: citation.fact_id,
        });
        continue;
      }
      if (!isFactAllowed(fact, context)) {
        issues.push({
          code: 'FACT_NOT_ALLOWED',
          severity: 'blocking',
          message: `Fact ${fact.id} is not allowed for this material.`,
          claim_id: claim.id,
          fact_id: fact.id,
        });
      }
      if (fact.version !== citation.fact_version) {
        issues.push({
          code: 'FACT_VERSION_MISMATCH',
          severity: 'blocking',
          message: `Citation expects fact ${fact.id} version ${citation.fact_version}, not ${fact.version}.`,
          claim_id: claim.id,
          fact_id: fact.id,
        });
        continue;
      }

      const field = parseClaimPath(citation.claim_path);
      if (!field || !Object.prototype.hasOwnProperty.call(fact.value, field)) {
        issues.push({
          code: 'FACT_PATH_INVALID',
          severity: 'blocking',
          message: `Citation path ${citation.claim_path} does not exist on fact ${fact.id}.`,
          claim_id: claim.id,
          fact_id: fact.id,
        });
        continue;
      }
      const rawValue = fact.value[field];
      if (rawValue === null || String(rawValue).trim().length === 0) {
        issues.push({
          code: 'FACT_PATH_INVALID',
          severity: 'blocking',
          message: `Citation path ${citation.claim_path} has no usable value.`,
          claim_id: claim.id,
          fact_id: fact.id,
        });
        continue;
      }
      const value = String(rawValue).trim();
      claimValues.push(value);
      const citationCopy = { ...citation };
      citations.set(citationKey(citation), citationCopy);
      evidence.push({ citation: citationCopy, source: { ...fact.source }, value });
    }

    if (claimValues.length === claim.citations.length && claim.text !== claimValues.join(' | ')) {
      issues.push({
        code: 'FACT_TEXT_ALTERED',
        severity: 'blocking',
        message:
          'Verified claim text must reproduce its cited fact values exactly and may not add facts.',
        claim_id: claim.id,
      });
    }
  }

  if (!document.claims.some((claim) => claim.status === 'verified')) {
    issues.push({
      code: 'CLAIM_NOT_TRACEABLE',
      severity: 'blocking',
      message: 'A publishable material requires at least one verified factual claim.',
    });
  }

  const referencedClaims = new Set<string>();
  for (const section of document.sections) {
    for (const claimId of section.claim_ids) {
      if (!claims.has(claimId)) {
        issues.push({
          code: 'UNREFERENCED_CLAIM',
          severity: 'blocking',
          message: `Section ${section.key} references unknown claim ${claimId}.`,
          claim_id: claimId,
        });
      }
      referencedClaims.add(claimId);
    }
  }
  for (const claimId of claims.keys()) {
    if (!referencedClaims.has(claimId)) {
      issues.push({
        code: 'UNREFERENCED_CLAIM',
        severity: 'blocking',
        message: `Claim ${claimId} is not included in a document section.`,
        claim_id: claimId,
      });
    }
  }

  if (document.plain_text !== renderMaterialDocumentText(document)) {
    issues.push({
      code: 'DOCUMENT_TEXT_MISMATCH',
      severity: 'blocking',
      message: 'Rendered text contains content not represented by the structured claims.',
    });
  }

  const wordCount = countWords(document.plain_text);
  const hasPlaceholders = PLACEHOLDER.test(document.plain_text);
  const atsCompatible = !hasAtsUnsafeContent(document.plain_text);
  if (hasPlaceholders) {
    issues.push({
      code: 'PLACEHOLDER_REMAINS',
      severity: 'blocking',
      message: 'The material contains an unresolved placeholder.',
    });
  }
  if (!atsCompatible) {
    issues.push({
      code: 'ATS_UNSAFE_CONTENT',
      severity: 'blocking',
      message: 'The material contains markup or control characters unsafe for ATS parsing.',
    });
  }
  if (constraints.minimum_words !== undefined && wordCount < constraints.minimum_words) {
    issues.push({
      code: 'WORD_COUNT_BELOW_MINIMUM',
      severity: 'warning',
      message: `The material has ${wordCount} words; minimum is ${constraints.minimum_words}.`,
    });
  }
  if (constraints.maximum_words !== undefined && wordCount > constraints.maximum_words) {
    issues.push({
      code: 'WORD_COUNT_ABOVE_MAXIMUM',
      severity: 'blocking',
      message: `The material has ${wordCount} words; maximum is ${constraints.maximum_words}.`,
    });
  }

  return {
    checks: {
      word_count: wordCount,
      character_count: [...document.plain_text].length,
      ats_compatible: atsCompatible,
      has_placeholders: hasPlaceholders,
      publishable: !issues.some((issue) => issue.severity === 'blocking'),
      issues,
    },
    citations: [...citations.values()].sort(compareCitations),
    evidence,
  };
}

export function countWords(value: string): number {
  const normalized = value.normalize('NFKC');
  const latinWords = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  let count = 0;
  for (const word of latinWords) {
    const cjk = word.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    );
    count += cjk ? cjk.length : 1;
  }
  return count;
}

export function renderMaterialDocumentText(document: MaterialDocument): string {
  const claims = new Map(document.claims.map((claim) => [claim.id, claim]));
  return [
    ...(document.title ? [document.title] : []),
    ...(document.preamble ?? []),
    ...document.sections.flatMap((section) => [
      ...(section.heading ? [section.heading] : []),
      ...section.claim_ids.flatMap((id) => {
        const claim = claims.get(id);
        return claim ? [claim.text] : [];
      }),
    ]),
    ...(document.closing ?? []),
  ].join('\n\n');
}

function validatePolicyContext(context: FactPolicyContext): void {
  if (!context.user_id?.trim()) {
    throw new MaterialsError('VALIDATION_FAILED', 'user_id is required.');
  }
  if (!Number.isFinite(Date.parse(context.evaluated_at))) {
    throw new MaterialsError('VALIDATION_FAILED', 'evaluated_at must be an ISO timestamp.');
  }
}

function validateConstraints(constraints: MaterialFormatConstraints): void {
  for (const [name, value] of Object.entries(constraints)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new MaterialsError('VALIDATION_FAILED', `${name} must be a non-negative integer.`);
    }
  }
  if (
    constraints.minimum_words !== undefined &&
    constraints.maximum_words !== undefined &&
    constraints.minimum_words > constraints.maximum_words
  ) {
    throw new MaterialsError('VALIDATION_FAILED', 'minimum_words cannot exceed maximum_words.');
  }
}

function parseOptionalDate(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasAtsUnsafeContent(value: string): boolean {
  if (HTML_MARKUP.test(value)) return true;
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
}

function parseClaimPath(path: string): string | undefined {
  return path.startsWith('value.') && path.length > 'value.'.length
    ? path.slice('value.'.length)
    : undefined;
}

function citationKey(citation: MaterialFactCitation): string {
  return `${citation.fact_id}\u0000${citation.fact_version}\u0000${citation.claim_path}`;
}

function compareCitations(left: MaterialFactCitation, right: MaterialFactCitation): number {
  return (
    left.fact_id.localeCompare(right.fact_id) ||
    left.fact_version - right.fact_version ||
    left.claim_path.localeCompare(right.claim_path)
  );
}

function sortFacts(facts: readonly Fact[]): Fact[] {
  return [...facts].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id) ||
      left.version - right.version,
  );
}
