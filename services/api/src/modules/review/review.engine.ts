import { randomUUID } from 'node:crypto';

import { ReviewError } from './review.errors';
import { createDefaultReviewers } from './review.reviewers';
import {
  REQUIRED_REVIEWERS,
  type AutomaticRevisionAgent,
  type FindingDisposition,
  type RequiredReviewer,
  type ReviewContext,
  type ReviewCycleOutcome,
  type ReviewExecutionConfiguration,
  type ReviewFinding,
  type ReviewOutcome,
  type ReviewerAgent,
  type ReviewerFindingDraft,
  type ReviewerReport,
  type ReviewRequest,
  type ReviewStatus,
  type ReviewSummary,
} from './review.types';

const MAX_REVIEW_ROUNDS = 3;

export const DEFAULT_REVIEW_EXECUTION_CONFIGURATION: ReviewExecutionConfiguration = {
  generator: {
    configuration_id: 'materials-deterministic-v1',
    provider: 'internal',
    model: 'deterministic-fact-template',
    role: 'generator',
  },
  reviewers: {
    ats: reviewerConfiguration('ats'),
    hard_requirements: reviewerConfiguration('hard_requirements'),
    fact_check: reviewerConfiguration('fact_check'),
    naturalness: reviewerConfiguration('naturalness'),
  },
};

interface EngineDependencies {
  clock?: () => string;
  idFactory?: () => string;
}

export async function runReview(
  request: ReviewRequest,
  reviewers: readonly ReviewerAgent[] = createDefaultReviewers(),
  dependencies: EngineDependencies = {},
): Promise<ReviewOutcome> {
  validateRequest(request);
  validateExecutionIsolation(request.execution);
  const agents = indexReviewers(reviewers);
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const idFactory = dependencies.idFactory ?? (() => randomUUID());
  const round = request.round ?? 1;
  const createdAt = clock();
  const transitions: ReviewStatus[] = ['queued', 'running'];
  const context = toContext(request);

  const settled = await Promise.allSettled(
    REQUIRED_REVIEWERS.map((reviewer) => {
      const agent = agents.get(reviewer);
      return Promise.resolve().then(() => {
        if (!agent) throw new Error('Reviewer is not registered.');
        return agent.review(clone(context), clone(request.execution.reviewers[reviewer]));
      });
    }),
  );
  const reports: ReviewerReport[] = [];
  const drafts: Array<{ reviewer: RequiredReviewer; finding: ReviewerFindingDraft }> = [];
  for (const [index, result] of settled.entries()) {
    const reviewer = REQUIRED_REVIEWERS[index]!;
    if (result.status === 'rejected') {
      const unavailable = unavailableFinding(context);
      reports.push({
        reviewer,
        configuration_id: request.execution.reviewers[reviewer].configuration_id,
        findings: [unavailable],
      });
      drafts.push({ reviewer, finding: unavailable });
      continue;
    }
    if (!isValidReport(result.value, reviewer, request.execution.reviewers[reviewer])) {
      const unavailable = unavailableFinding(context);
      reports.push({
        reviewer,
        configuration_id: request.execution.reviewers[reviewer].configuration_id,
        findings: [unavailable],
      });
      drafts.push({ reviewer, finding: unavailable });
      continue;
    }
    reports.push(clone(result.value));
    drafts.push(...result.value.findings.map((finding) => ({ reviewer, finding: clone(finding) })));
  }

  const findingDispositions = new Map<string, FindingDisposition>();
  const findings: ReviewFinding[] = drafts.map(({ reviewer, finding }) => {
    if (finding.evidence_refs.length === 0) {
      throw new ReviewError('VALIDATION_FAILED', 'Every review finding must include evidence.');
    }
    const id = idFactory();
    findingDispositions.set(id, finding.disposition);
    return {
      id,
      reviewer,
      severity: finding.severity,
      category: finding.category,
      message: finding.message,
      evidence_refs: clone(finding.evidence_refs),
      status: 'open' as const,
    };
  });

  let summary = summarize(findings, findingDispositions);
  let terminal = decide(summary, round);
  if (terminal.status === 'needs_human' && round === MAX_REVIEW_ROUNDS && !hasHuman(summary)) {
    const source = findings.find((finding) =>
      [...summary.must_fix, ...summary.auto_revision].includes(finding.id),
    );
    if (source) {
      const limitFinding: ReviewFinding = {
        id: idFactory(),
        reviewer: source.reviewer,
        severity: 'must_fix',
        category: 'revision_round_limit',
        message: `Automatic review/revision reached the ${MAX_REVIEW_ROUNDS}-round limit.`,
        evidence_refs: clone(source.evidence_refs),
        status: 'open',
      };
      findings.push(limitFinding);
      findingDispositions.set(limitFinding.id, 'human_review');
      summary = summarize(findings, findingDispositions);
      terminal = decide(summary, round);
    }
  }
  transitions.push(terminal.status);
  const updatedAt = clock();
  return {
    review: {
      id: request.review_id ?? idFactory(),
      user_id: request.user_id,
      job_id: request.job.id,
      material_ids: request.materials.map((material) => material.id),
      status: terminal.status,
      reviewers: [...REQUIRED_REVIEWERS],
      findings,
      recommendation: terminal.recommendation,
      round,
      version: transitions.length,
      created_at: createdAt,
      updated_at: updatedAt,
    },
    summary,
    reports,
    transitions,
  };
}

export async function runReviewCycle(
  request: Omit<ReviewRequest, 'round' | 'review_id'>,
  revisionAgent: AutomaticRevisionAgent,
  reviewers: readonly ReviewerAgent[] = createDefaultReviewers(),
  dependencies: EngineDependencies = {},
): Promise<ReviewCycleOutcome> {
  assertSameConfiguration(request.execution.generator, revisionAgent.configuration);
  let context: ReviewContext = toContext(request);
  const rounds: ReviewOutcome[] = [];
  let automaticRevisions = 0;

  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round += 1) {
    const outcome = await runReview(
      { ...context, execution: request.execution, round },
      reviewers,
      dependencies,
    );
    rounds.push(outcome);
    if (outcome.review.status !== 'requires_changes') {
      return { outcome, rounds, automatic_revisions: automaticRevisions };
    }
    if (outcome.summary.must_fix.length > 0 || outcome.summary.auto_revision.length === 0) {
      return { outcome, rounds, automatic_revisions: automaticRevisions };
    }
    context = await revisionAgent.revise(
      context,
      outcome.review.findings.filter((finding) =>
        outcome.summary.auto_revision.includes(finding.id),
      ),
      round + 1,
    );
    automaticRevisions += 1;
  }

  return {
    outcome: rounds[rounds.length - 1]!,
    rounds,
    automatic_revisions: automaticRevisions,
  };
}

export function validateExecutionIsolation(execution: ReviewExecutionConfiguration): void {
  if (!execution || execution.generator?.role !== 'generator') {
    throw new ReviewError('VALIDATION_FAILED', 'A generator execution configuration is required.');
  }
  const generatorModel = modelIdentity(execution.generator);
  const configurationIds = new Set<string>([execution.generator.configuration_id]);
  for (const reviewer of REQUIRED_REVIEWERS) {
    const configuration = execution.reviewers?.[reviewer];
    if (
      !configuration ||
      configuration.role !== 'reviewer' ||
      configuration.reviewer !== reviewer
    ) {
      throw new ReviewError(
        'VALIDATION_FAILED',
        `An isolated configuration is required for reviewer ${reviewer}.`,
      );
    }
    if (configurationIds.has(configuration.configuration_id)) {
      throw new ReviewError(
        'REVIEW_CONFIGURATION_NOT_ISOLATED',
        'Generator and reviewer configuration ids must be distinct.',
      );
    }
    configurationIds.add(configuration.configuration_id);
    if (modelIdentity(configuration) === generatorModel) {
      throw new ReviewError(
        'REVIEW_CONFIGURATION_NOT_ISOLATED',
        `Reviewer ${reviewer} cannot use the generator model.`,
      );
    }
  }
}

function validateRequest(request: ReviewRequest): void {
  if (!request || !request.user_id?.trim()) {
    throw new ReviewError('VALIDATION_FAILED', 'user_id is required.');
  }
  if (!request.job || !Array.isArray(request.materials) || request.materials.length === 0) {
    throw new ReviewError('VALIDATION_FAILED', 'A job and at least one material are required.');
  }
  if (request.materials.some((material) => material.user_id !== request.user_id)) {
    throw new ReviewError('VALIDATION_FAILED', 'Review materials must belong to the review user.');
  }
  if (
    request.materials.some(
      (material) => material.job_id !== undefined && material.job_id !== request.job.id,
    )
  ) {
    throw new ReviewError('VALIDATION_FAILED', 'Review materials must belong to the review job.');
  }
  const materialIds = new Set(request.materials.map((material) => material.id));
  if (materialIds.size !== request.materials.length || request.materials.length > 20) {
    throw new ReviewError('VALIDATION_FAILED', 'material ids must be unique and limited to 20.');
  }
  const round = request.round ?? 1;
  if (!Number.isInteger(round) || round < 1 || round > MAX_REVIEW_ROUNDS) {
    throw new ReviewError('VALIDATION_FAILED', 'round must be an integer from 1 through 3.');
  }
  if (!Number.isFinite(Date.parse(request.evaluated_at))) {
    throw new ReviewError('VALIDATION_FAILED', 'evaluated_at must be an RFC 3339 timestamp.');
  }
}

function indexReviewers(reviewers: readonly ReviewerAgent[]): Map<RequiredReviewer, ReviewerAgent> {
  const result = new Map<RequiredReviewer, ReviewerAgent>();
  for (const reviewer of reviewers) {
    if (result.has(reviewer.reviewer)) {
      throw new ReviewError('VALIDATION_FAILED', `Duplicate reviewer: ${reviewer.reviewer}.`);
    }
    result.set(reviewer.reviewer, reviewer);
  }
  return result;
}

function summarize(
  findings: readonly ReviewFinding[],
  dispositions: ReadonlyMap<string, FindingDisposition>,
): ReviewSummary {
  const summary: ReviewSummary = { must_fix: [], auto_revision: [], human_review: [] };
  for (const finding of findings) {
    const disposition = dispositions.get(finding.id);
    if (disposition) summary[disposition].push(finding.id);
  }
  return summary;
}

function decide(
  summary: ReviewSummary,
  round: number,
): { status: ReviewStatus; recommendation: ReviewOutcome['review']['recommendation'] } {
  if (hasHuman(summary) || (round >= MAX_REVIEW_ROUNDS && hasRequiredChange(summary))) {
    return { status: 'needs_human', recommendation: 'human_review' };
  }
  if (hasRequiredChange(summary)) {
    return { status: 'requires_changes', recommendation: 'revise' };
  }
  return { status: 'approved', recommendation: 'approve' };
}

function hasHuman(summary: ReviewSummary): boolean {
  return summary.human_review.length > 0;
}

function hasRequiredChange(summary: ReviewSummary): boolean {
  return summary.must_fix.length > 0 || summary.auto_revision.length > 0;
}

function unavailableFinding(context: ReviewContext): ReviewerFindingDraft {
  const material = context.materials[0];
  return {
    severity: 'must_fix',
    category: 'reviewer_unavailable',
    message:
      'An independent reviewer was unavailable; this review cannot be approved automatically.',
    evidence_refs: material
      ? [{ type: 'material', id: material.id, version: material.version }]
      : [{ type: 'job', id: context.job.id, version: context.job.version }],
    disposition: 'human_review',
  };
}

function isValidReport(
  report: ReviewerReport,
  reviewer: RequiredReviewer,
  configuration: ReviewExecutionConfiguration['reviewers'][RequiredReviewer],
): boolean {
  return (
    report?.reviewer === reviewer &&
    report.configuration_id === configuration.configuration_id &&
    Array.isArray(report.findings) &&
    report.findings.length <= 500 &&
    report.findings.every(isValidFindingDraft)
  );
}

function isValidFindingDraft(finding: ReviewerFindingDraft): boolean {
  return (
    finding !== null &&
    typeof finding === 'object' &&
    ['info', 'warning', 'must_fix'].includes(finding.severity) &&
    typeof finding.category === 'string' &&
    finding.category.trim().length > 0 &&
    finding.category.length <= 100 &&
    typeof finding.message === 'string' &&
    finding.message.trim().length > 0 &&
    finding.message.length <= 2_000 &&
    ['must_fix', 'auto_revision', 'human_review'].includes(finding.disposition) &&
    Array.isArray(finding.evidence_refs) &&
    finding.evidence_refs.length > 0 &&
    finding.evidence_refs.length <= 100 &&
    finding.evidence_refs.every(
      (reference) =>
        reference !== null &&
        typeof reference === 'object' &&
        ['fact', 'material', 'job', 'review'].includes(reference.type) &&
        typeof reference.id === 'string' &&
        reference.id.trim().length > 0 &&
        (reference.version === undefined ||
          (Number.isInteger(reference.version) && reference.version > 0)),
    )
  );
}

function modelIdentity(configuration: { provider: string; model: string }): string {
  return `${configuration.provider.trim().toLocaleLowerCase('en-US')}:${configuration.model
    .trim()
    .toLocaleLowerCase('en-US')}`;
}

function assertSameConfiguration(
  expected: ReviewExecutionConfiguration['generator'],
  actual: ReviewExecutionConfiguration['generator'],
): void {
  if (
    expected.configuration_id !== actual.configuration_id ||
    modelIdentity(expected) !== modelIdentity(actual) ||
    actual.role !== 'generator'
  ) {
    throw new ReviewError(
      'REVIEW_CONFIGURATION_NOT_ISOLATED',
      'The automatic revision agent must use the declared generator configuration.',
    );
  }
}

function reviewerConfiguration(reviewer: RequiredReviewer) {
  return {
    configuration_id: `review-${reviewer}-v1`,
    provider: 'internal',
    model: `deterministic-${reviewer}-reviewer`,
    role: 'reviewer' as const,
    reviewer,
  };
}

function toContext(request: ReviewContext): ReviewContext {
  return {
    user_id: request.user_id,
    ...(request.goal_id ? { goal_id: request.goal_id } : {}),
    job: clone(request.job),
    materials: clone(request.materials),
    facts: clone(request.facts),
    requirements: clone(request.requirements),
    ...(request.required_material_kinds
      ? { required_material_kinds: [...request.required_material_kinds] }
      : {}),
    evaluated_at: request.evaluated_at,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
