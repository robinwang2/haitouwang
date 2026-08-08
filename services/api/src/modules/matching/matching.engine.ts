import { createHash } from 'node:crypto';

import type { Fact } from '../profile';
import {
  MATCHING_WEIGHTS,
  MatchingInputError,
  type HardGate,
  type HardGateResult,
  type MatchBand,
  type MatchingDecision,
  type MatchingInput,
  type MatchingScore,
  type ScoreDimension,
  type ScoreDimensionName,
} from './matching.types';

const DIMENSION_ORDER: ScoreDimensionName[] = [
  'skills',
  'experience',
  'work_authorization',
  'location',
  'salary',
  'employment_type',
  'preference',
];

export function scoreMatch(input: MatchingInput): MatchingScore {
  validateInput(input);

  const facts = usableFacts(input);
  const hardGates = evaluateHardGates(input);
  const gateByName = new Map(hardGates.map((gate) => [gate.name, gate.result]));
  const dimensions: ScoreDimension[] = [
    dimension(
      'skills',
      coverageScore(input.requirements.required_skills, factTerms(facts, ['skill'])),
      ['requirements.required_skills', 'facts[kind=skill].value'],
    ),
    dimension(
      'experience',
      coverageScore(
        input.requirements.experience_keywords,
        factTerms(facts, ['experience', 'project']),
      ),
      ['requirements.experience_keywords', 'facts[kind=experience|project].value'],
    ),
    dimension('work_authorization', gateScore(requiredGate(gateByName, 'work_authorization')), [
      'goal.work_authorization_rule',
      'requirements.work_authorization',
    ]),
    dimension('location', gateScore(requiredGate(gateByName, 'location')), [
      'goal.locations',
      'job.location',
    ]),
    dimension('salary', gateScore(requiredGate(gateByName, 'salary')), [
      'goal.salary',
      'job.salary',
    ]),
    dimension('employment_type', gateScore(requiredGate(gateByName, 'employment_type')), [
      'goal.employment_types',
      'job.employment_type',
    ]),
    dimension('preference', preferenceScore(input, facts), [
      'goal.title_keywords',
      'requirements.preference_keywords',
      'facts[kind=preference].value',
      'job.title',
    ]),
  ];

  const total = round(dimensions.reduce((sum, item) => sum + (item.weight * item.score) / 100, 0));
  const decision = decisionFromGates(hardGates);
  const inputVersion = hashCanonical(scoringPayload(input));

  return {
    id: deterministicUuid(
      hashCanonical({
        user_id: input.user_id,
        goal_id: input.goal.id,
        job_id: input.job.id,
        input_version: inputVersion,
      }),
    ),
    user_id: input.user_id,
    goal_id: input.goal.id,
    job_id: input.job.id,
    total,
    dimensions,
    hard_gates: hardGates,
    decision,
    explanations: buildExplanations(dimensions, hardGates),
    input_version: inputVersion,
    created_at: input.evaluated_at,
  };
}

export function classifyMatchScore(total: number): MatchBand {
  if (!Number.isFinite(total) || total < 0 || total > 100) {
    throw new MatchingInputError('total must be between 0 and 100.');
  }
  if (total >= 90) return 'exceptional';
  if (total >= 80) return 'high';
  if (total >= 70) return 'worth_applying';
  if (total >= 55) return 'review';
  return 'low';
}

function evaluateHardGates(input: MatchingInput): HardGate[] {
  return [
    gate('work_authorization', workAuthorizationGate(input), [
      'goal.work_authorization_rule',
      'requirements.work_authorization',
    ]),
    gate('blacklist', blacklistGate(input), [
      'context.blacklisted_companies',
      'context.blacklisted_title_keywords',
      'job.company',
      'job.title',
    ]),
    gate('duplicate', duplicateGate(input), ['context.already_applied_job_ids', 'job.id']),
    gate('location', locationGate(input), ['goal.locations', 'job.location']),
    gate('salary', salaryGate(input), ['goal.salary', 'job.salary']),
    gate('employment_type', employmentTypeGate(input), [
      'goal.employment_types',
      'job.employment_type',
    ]),
    gate('risk', riskGate(input), [
      'job.risk.level',
      'job.risk.requires_manual_review',
      'job.status',
    ]),
  ];
}

function workAuthorizationGate(input: MatchingInput): HardGateResult {
  const rule = input.goal.work_authorization_rule;
  const requirement = input.requirements.work_authorization;

  if (rule === undefined || rule === 'unknown' || rule === 'manual_only') {
    return 'manual';
  }
  if (rule === 'authorized') {
    return 'pass';
  }
  if (requirement === 'sponsorship_available' || requirement === 'not_required') {
    return 'pass';
  }
  if (requirement === 'sponsorship_unavailable') {
    return 'block';
  }
  return 'manual';
}

function blacklistGate(input: MatchingInput): HardGateResult {
  const company = normalize(input.job.company);
  const title = normalize(input.job.title);
  const companyBlocked = input.context.blacklisted_companies.some(
    (candidate) => normalize(candidate) === company,
  );
  const titleBlocked = input.context.blacklisted_title_keywords.some((candidate) =>
    title.includes(normalize(candidate)),
  );
  return companyBlocked || titleBlocked ? 'block' : 'pass';
}

function duplicateGate(input: MatchingInput): HardGateResult {
  return input.context.already_applied_job_ids.includes(input.job.id) ? 'block' : 'pass';
}

function locationGate(input: MatchingInput): HardGateResult {
  if (input.goal.locations.length === 0) return 'pass';
  if (normalize(input.job.location) === 'unknown') return 'manual';
  return input.goal.locations.some((location) => termsMatch(location, input.job.location))
    ? 'pass'
    : 'block';
}

function salaryGate(input: MatchingInput): HardGateResult {
  const desired = input.goal.salary;
  if (desired === undefined) return 'pass';
  const offered = input.job.salary;
  if (offered === undefined) return 'manual';
  if (desired.currency !== offered.currency) return 'manual';
  if (
    desired.period !== undefined &&
    offered.period !== undefined &&
    desired.period !== offered.period
  ) {
    return 'manual';
  }
  if (
    desired.minimum !== undefined &&
    offered.maximum !== undefined &&
    offered.maximum < desired.minimum
  ) {
    return 'block';
  }
  if (
    desired.maximum !== undefined &&
    offered.minimum !== undefined &&
    offered.minimum > desired.maximum
  ) {
    return 'block';
  }
  if (
    desired.minimum !== undefined &&
    offered.minimum === undefined &&
    offered.maximum === undefined
  ) {
    return 'manual';
  }
  return 'pass';
}

function employmentTypeGate(input: MatchingInput): HardGateResult {
  if (input.goal.employment_types.length === 0) return 'pass';
  if (input.job.employment_type === 'unknown') return 'manual';
  return input.goal.employment_types.includes(input.job.employment_type) ? 'pass' : 'block';
}

function riskGate(input: MatchingInput): HardGateResult {
  if (input.job.status === 'expired' || input.job.status === 'removed') {
    return 'block';
  }
  if (input.job.risk.level === 'high') return 'block';
  if (
    input.job.risk.level === 'medium' ||
    input.job.risk.level === 'unknown' ||
    input.job.risk.requires_manual_review
  ) {
    return 'manual';
  }
  return 'pass';
}

function preferenceScore(input: MatchingInput, facts: Fact[]): number {
  const preferences = [
    ...input.goal.title_keywords,
    ...(input.requirements.preference_keywords ?? []),
    ...factTerms(facts, ['preference']),
  ];
  if (preferences.length === 0) return 100;
  return preferences.some((term) => termsMatch(term, input.job.title)) ? 100 : 0;
}

function usableFacts(input: MatchingInput): Fact[] {
  const evaluatedAt = Date.parse(input.evaluated_at);
  return input.facts.filter((fact) => {
    if (fact.user_id !== input.user_id || fact.status !== 'active') return false;
    if (
      fact.scope.use === 'manual_only' ||
      fact.scope.use === 'prohibited' ||
      (fact.scope.use === 'selected_goals' && !fact.scope.goal_ids?.includes(input.goal.id))
    ) {
      return false;
    }
    const validFrom = fact.valid_from === undefined ? undefined : Date.parse(fact.valid_from);
    const validUntil = fact.valid_until === undefined ? undefined : Date.parse(fact.valid_until);
    return (
      (validFrom === undefined || validFrom <= evaluatedAt) &&
      (validUntil === undefined || validUntil >= evaluatedAt)
    );
  });
}

function factTerms(facts: Fact[], kinds: Fact['kind'][]): string[] {
  return facts
    .filter((fact) => kinds.includes(fact.kind))
    .flatMap((fact) =>
      Object.values(fact.value)
        .filter((value): value is string => typeof value === 'string')
        .flatMap((value) => value.split(/[,;|]/)),
    )
    .map((value) => value.trim())
    .filter(Boolean);
}

function coverageScore(required: string[], available: string[]): number {
  const uniqueRequired = uniqueNormalized(required);
  if (uniqueRequired.length === 0) return 100;
  const matched = uniqueRequired.filter((requirement) =>
    available.some((candidate) => termsMatch(requirement, candidate)),
  ).length;
  return round((matched / uniqueRequired.length) * 100);
}

function termsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return false;
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))].sort();
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim();
}

function dimension(
  name: ScoreDimensionName,
  score: number,
  evidencePaths: string[],
): ScoreDimension {
  return {
    name,
    weight: MATCHING_WEIGHTS[name],
    score: round(score),
    evidence_paths: evidencePaths,
  };
}

function gate(name: HardGate['name'], result: HardGateResult, evidencePaths: string[]): HardGate {
  return { name, result, evidence_paths: evidencePaths };
}

function gateScore(result: HardGateResult): number {
  if (result === 'pass') return 100;
  if (result === 'manual') return 50;
  return 0;
}

function requiredGate(
  gates: Map<HardGate['name'], HardGateResult>,
  name: HardGate['name'],
): HardGateResult {
  const result = gates.get(name);
  if (result === undefined) {
    throw new MatchingInputError(`Missing required hard gate: ${name}.`);
  }
  return result;
}

function decisionFromGates(gates: HardGate[]): MatchingDecision {
  if (gates.some((gateItem) => gateItem.result === 'block')) return 'blocked';
  if (gates.some((gateItem) => gateItem.result === 'manual')) {
    return 'manual_review';
  }
  return 'eligible';
}

function buildExplanations(dimensions: ScoreDimension[], gates: HardGate[]): string[] {
  const explanations = dimensions.map((item) => {
    const category = item.score >= 80 ? 'strength' : 'gap';
    return `${category}: ${item.name} scored ${item.score}/100 [${item.evidence_paths.join(', ')}]`;
  });
  for (const gateItem of gates.filter((item) => item.result !== 'pass')) {
    explanations.push(
      `recommendation: ${gateItem.name} is ${gateItem.result}; ${
        gateItem.result === 'block' ? 'do not proceed' : 'require human confirmation'
      } [${gateItem.evidence_paths.join(', ')}]`,
    );
  }
  return explanations;
}

function validateInput(input: MatchingInput): void {
  if (input.goal.user_id !== input.user_id) {
    throw new MatchingInputError('goal.user_id must match user_id.');
  }
  if (!Number.isFinite(Date.parse(input.evaluated_at))) {
    throw new MatchingInputError('evaluated_at must be an ISO timestamp.');
  }
  if (input.facts.some((fact) => fact.user_id !== input.user_id)) {
    throw new MatchingInputError('facts must belong to user_id.');
  }
  const weightTotal = DIMENSION_ORDER.reduce((sum, name) => sum + MATCHING_WEIGHTS[name], 0);
  if (weightTotal !== 100) {
    throw new MatchingInputError('Matching weights must total 100.');
  }
}

function scoringPayload(input: MatchingInput): MatchingInput {
  return {
    user_id: input.user_id,
    goal: input.goal,
    job: input.job,
    facts: input.facts,
    requirements: input.requirements,
    context: input.context,
    evaluated_at: input.evaluated_at,
  };
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function deterministicUuid(hash: string): string {
  const characters = hash.slice(0, 32).split('');
  characters[12] = '5';
  characters[16] = ((Number.parseInt(characters[16], 16) & 0x3) | 0x8).toString(16);
  const compact = characters.join('');
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join('-');
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
