import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Job } from '../../src/modules/jobs';
import {
  renderMaterialDocumentText,
  type Material,
  type MaterialDocument,
} from '../../src/modules/materials';
import type { Fact } from '../../src/modules/profile';
import {
  createDefaultReviewers,
  DEFAULT_REVIEW_EXECUTION_CONFIGURATION,
  runReview,
  runReviewCycle,
  type AutomaticRevisionAgent,
  type FindingDisposition,
  type RequiredReviewer,
  type ReviewerAgent,
  type ReviewerExecutionConfiguration,
  type ReviewerFindingDraft,
  type ReviewerReport,
  type ReviewRequest,
  type ReviewError,
} from '../../src/modules/review';

const NOW = '2026-07-31T12:00:00.000Z';
const USER_ID = '10000000-0000-4000-8000-000000000001';
const JOB_ID = '20000000-0000-4000-8000-000000000002';
const MATERIAL_ID = '30000000-0000-4000-8000-000000000003';
const FACT_ID = '40000000-0000-4000-8000-000000000004';
const SECOND_FACT_ID = '40000000-0000-4000-8000-000000000005';
const THIRD_FACT_ID = '40000000-0000-4000-8000-000000000006';

interface GoldenSample {
  name: string;
  scenario:
    | 'pass'
    | 'contradiction'
    | 'fabrication'
    | 'critical_missing'
    | 'evidence_conflict'
    | 'authorization_conflict'
    | 'risk_review';
  expected_status: 'approved' | 'requires_changes' | 'needs_human';
  expected_recommendation: 'approve' | 'revise' | 'human_review';
  expected_category: string | null;
  expected_bucket: FindingDisposition | null;
  expected_findings: Array<{
    reviewer: RequiredReviewer;
    severity: 'info' | 'warning' | 'must_fix';
    category: string;
    message: string;
    evidence_refs: Array<{
      type: 'fact' | 'material' | 'job' | 'review';
      id: string;
      version?: number;
    }>;
    status: 'open' | 'resolved' | 'accepted_risk';
  }>;
}

function readGoldenSamples(): GoldenSample[] {
  const path = fileURLToPath(
    new URL('../../../../evals/review/golden-samples.json', import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenSample[];
}

describe('independent application review golden evaluation', () => {
  it.each(readGoldenSamples())('$name', async (sample) => {
    const request = requestFor(sample.scenario);
    const outcome = await runReview(request, createDefaultReviewers(), deterministicDependencies());

    expect(outcome.review.status).toBe(sample.expected_status);
    expect(outcome.review.recommendation).toBe(sample.expected_recommendation);
    expect(outcome.transitions).toEqual(['queued', 'running', sample.expected_status]);
    expect(outcome.reports.map((report) => report.reviewer)).toEqual([
      'ats',
      'hard_requirements',
      'fact_check',
      'naturalness',
    ]);
    expect(new Set(outcome.reports.map((report) => report.configuration_id)).size).toBe(4);
    expect(outcome.review.findings.every((finding) => finding.evidence_refs.length > 0)).toBe(true);
    expect(
      outcome.review.findings.map(({ id: _id, message, ...finding }) => ({
        ...finding,
        message: normalizeGoldenMessage(message),
      })),
    ).toEqual(sample.expected_findings);

    if (sample.expected_category && sample.expected_bucket) {
      const finding = outcome.review.findings.find(
        (candidate) => candidate.category === sample.expected_category,
      );
      expect(finding).toBeDefined();
      expect(outcome.summary[sample.expected_bucket]).toContain(finding!.id);
      expect(outcome.review.recommendation).not.toBe('approve');
    } else {
      expect(outcome.review.findings).toEqual([]);
    }
  });

  it('catches every known contradiction, fabrication, and critical-missing golden sample', async () => {
    const defects = readGoldenSamples().filter((sample) => sample.scenario !== 'pass');
    const outcomes = await Promise.all(
      defects.map((sample) => runReview(requestFor(sample.scenario))),
    );

    expect(outcomes).toHaveLength(defects.length);
    expect(
      outcomes.every(
        (outcome) => outcome.summary.must_fix.length > 0 || outcome.summary.human_review.length > 0,
      ),
    ).toBe(true);
  });
});

describe('decision gates and execution isolation', () => {
  it('returns separate evidence findings from the ATS and naturalness reviewers', async () => {
    const request = requestFor('pass');
    const modelVoice = '<b>As an AI language model, I delve into reliable systems</b>';
    request.facts[0]!.value.name = modelVoice;
    request.materials[0]!.document.claims[0]!.text = modelVoice;
    request.materials[0]!.document.plain_text = renderMaterialDocumentText(
      request.materials[0]!.document,
    );
    request.requirements.required_skills = [];

    const outcome = await runReview(request);
    const atsReport = outcome.reports.find((report) => report.reviewer === 'ats');
    const naturalnessReport = outcome.reports.find((report) => report.reviewer === 'naturalness');

    expect(atsReport?.findings).toContainEqual(
      expect.objectContaining({ category: 'ats_unsafe_structure' }),
    );
    expect(naturalnessReport?.findings).toContainEqual(
      expect.objectContaining({ category: 'model_voice' }),
    );
    expect(
      [...atsReport!.findings, ...naturalnessReport!.findings].every(
        (finding) => finding.evidence_refs.length > 0,
      ),
    ).toBe(true);
  });

  it('routes an unavailable independent reviewer to human review', async () => {
    const reviewers = createDefaultReviewers().map((reviewer) =>
      reviewer.reviewer === 'ats' ? rejectingReviewer('ats') : reviewer,
    );
    const outcome = await runReview(requestFor('pass'), reviewers);

    expect(outcome.review.status).toBe('needs_human');
    expect(outcome.review.recommendation).toBe('human_review');
    const unavailable = outcome.review.findings.find(
      (finding) => finding.category === 'reviewer_unavailable',
    );
    expect(unavailable?.reviewer).toBe('ats');
    expect(outcome.summary.human_review).toContain(unavailable!.id);
  });

  it('isolates each reviewer from mutations made by another reviewer', async () => {
    const mutatingAts: ReviewerAgent = {
      reviewer: 'ats',
      async review(context, configuration): Promise<ReviewerReport> {
        context.materials[0]!.document.claims[0]!.text = 'mutated by another reviewer';
        return { reviewer: 'ats', configuration_id: configuration.configuration_id, findings: [] };
      },
    };
    const outcome = await runReview(
      requestFor('pass'),
      withReviewer(createDefaultReviewers(), mutatingAts),
    );

    expect(outcome.review.status).toBe('approved');
    expect(outcome.reports.find((report) => report.reviewer === 'fact_check')?.findings).toEqual(
      [],
    );
  });

  it('routes an invalid evidence-less reviewer report to human review', async () => {
    const invalidNaturalness = scriptedReviewer('naturalness', () => [
      { ...autoFinding('Missing evidence.'), evidence_refs: [] },
    ]);
    const outcome = await runReview(
      requestFor('pass'),
      withReviewer(createDefaultReviewers(), invalidNaturalness),
    );

    expect(outcome.review.status).toBe('needs_human');
    expect(outcome.review.findings).toContainEqual(
      expect.objectContaining({
        reviewer: 'naturalness',
        category: 'reviewer_unavailable',
        evidence_refs: [{ type: 'material', id: MATERIAL_ID, version: 1 }],
      }),
    );
  });

  it('rejects any reviewer configured with the generator model', async () => {
    const execution = structuredClone(DEFAULT_REVIEW_EXECUTION_CONFIGURATION);
    execution.reviewers.fact_check = {
      ...execution.reviewers.fact_check,
      provider: execution.generator.provider,
      model: execution.generator.model,
    };

    await expect(runReview({ ...requestFor('pass'), execution })).rejects.toMatchObject({
      code: 'REVIEW_CONFIGURATION_NOT_ISOLATED',
    } satisfies Partial<ReviewError>);
  });

  it('uses finding gates rather than an injected total score', async () => {
    const request = {
      ...requestFor('fabrication'),
      total_score: 100,
    } as ReviewRequest & { total_score: number };
    const outcome = await runReview(request);

    expect(outcome.review.status).toBe('requires_changes');
    expect(outcome.review.recommendation).toBe('revise');
  });
});

describe('hard-requirement safety gates', () => {
  it('compares every work-authorization fact independently of fact order', async () => {
    const request = requestFor('pass');
    request.facts.push(
      workAuthorizationFact(THIRD_FACT_ID, 'requires_sponsorship'),
      workAuthorizationFact(SECOND_FACT_ID, 'authorized'),
    );
    request.requirements.work_authorization = 'sponsorship_unavailable';
    const permuted = structuredClone(request);
    permuted.facts.reverse();

    const [first, second] = await Promise.all([
      runReview(request, createDefaultReviewers(), deterministicDependencies()),
      runReview(permuted, createDefaultReviewers(), deterministicDependencies()),
    ]);
    const firstConflict = first.review.findings.find(
      (finding) => finding.category === 'evidence_conflict',
    );
    const secondConflict = second.review.findings.find(
      (finding) => finding.category === 'evidence_conflict',
    );

    expect(first.review.status).toBe('needs_human');
    expect(second.review.status).toBe('needs_human');
    expect(firstConflict?.evidence_refs).toEqual([
      { type: 'job', id: JOB_ID, version: 1 },
      { type: 'fact', id: SECOND_FACT_ID, version: 1 },
      { type: 'fact', id: THIRD_FACT_ID, version: 1 },
    ]);
    expect(secondConflict).toEqual(firstConflict);
    expect(first.summary.human_review).toContain(firstConflict!.id);
  });

  it.each([
    {
      name: 'risk_review status',
      mutate: (reviewJob: Job) => {
        reviewJob.status = 'risk_review';
      },
    },
    {
      name: 'high risk',
      mutate: (reviewJob: Job) => {
        reviewJob.risk.level = 'high';
      },
    },
    {
      name: 'unknown risk',
      mutate: (reviewJob: Job) => {
        reviewJob.risk.level = 'unknown';
      },
    },
    {
      name: 'explicit manual-review flag',
      mutate: (reviewJob: Job) => {
        reviewJob.risk.requires_manual_review = true;
      },
    },
  ])('routes $name jobs to human review', async ({ mutate }) => {
    const request = requestFor('pass');
    mutate(request.job);

    const outcome = await runReview(request);

    expect(outcome.review.status).toBe('needs_human');
    expect(outcome.review.recommendation).toBe('human_review');
    expect(outcome.review.findings).toContainEqual(
      expect.objectContaining({
        reviewer: 'hard_requirements',
        category: 'job_risk_requires_review',
        evidence_refs: [{ type: 'job', id: JOB_ID, version: 1 }],
      }),
    );
  });

  it('caps the merged findings from all four reports at the Review schema limit', async () => {
    const reviewers = createDefaultReviewers().map(({ reviewer }) =>
      scriptedReviewer(reviewer, () =>
        Array.from({ length: 126 }, (_, index) =>
          autoFinding(`${reviewer} synthetic boundary finding ${index + 1}.`),
        ),
      ),
    );

    const outcome = await runReview(requestFor('pass'), reviewers);

    expect(outcome.reports.reduce((total, report) => total + report.findings.length, 0)).toBe(504);
    expect(outcome.review.findings).toHaveLength(500);
    expect(outcome.review.findings.at(-1)).toEqual(
      expect.objectContaining({ category: 'review_finding_limit_exceeded' }),
    );
    expect(outcome.review.status).toBe('needs_human');
    expect(outcome.summary.human_review).toContain(outcome.review.findings.at(-1)!.id);
  });

  it('keeps the third-round limit finding inside the 500-finding contract boundary', async () => {
    const reviewers = createDefaultReviewers().map(({ reviewer }) =>
      scriptedReviewer(reviewer, () =>
        Array.from({ length: 125 }, (_, index) =>
          autoFinding(`${reviewer} third-round boundary finding ${index + 1}.`),
        ),
      ),
    );
    const request = requestFor('pass');
    request.round = 3;

    const outcome = await runReview(request, reviewers);

    expect(outcome.review.findings).toHaveLength(500);
    expect(outcome.review.findings.at(-1)).toEqual(
      expect.objectContaining({ category: 'revision_round_limit' }),
    );
    expect(outcome.review.status).toBe('needs_human');
    expect(outcome.summary.human_review).toContain(outcome.review.findings.at(-1)!.id);
  });
});

describe('bounded automatic revision', () => {
  it('approves after an isolated automatic revision removes a safe finding', async () => {
    let revised = false;
    const reviewers = withReviewer(
      createDefaultReviewers(),
      scriptedReviewer('naturalness', () =>
        revised ? [] : [autoFinding('Language can be simplified safely.')],
      ),
    );
    const revisionAgent: AutomaticRevisionAgent = {
      configuration: structuredClone(DEFAULT_REVIEW_EXECUTION_CONFIGURATION.generator),
      async revise(context) {
        revised = true;
        return structuredClone(context);
      },
    };

    const result = await runReviewCycle(
      stripRoundAndId(requestFor('pass')),
      revisionAgent,
      reviewers,
      deterministicDependencies(),
    );

    expect(result.automatic_revisions).toBe(1);
    expect(result.rounds).toHaveLength(2);
    expect(result.outcome.review.round).toBe(2);
    expect(result.outcome.review.status).toBe('approved');
  });

  it('stops at the third review round and requires human review', async () => {
    const reviewers = withReviewer(
      createDefaultReviewers(),
      scriptedReviewer('naturalness', () => [autoFinding('Persistent repetitive language.')]),
    );
    const revisionAgent: AutomaticRevisionAgent = {
      configuration: structuredClone(DEFAULT_REVIEW_EXECUTION_CONFIGURATION.generator),
      async revise(context) {
        return structuredClone(context);
      },
    };

    const result = await runReviewCycle(
      stripRoundAndId(requestFor('pass')),
      revisionAgent,
      reviewers,
    );

    expect(result.rounds).toHaveLength(3);
    expect(result.automatic_revisions).toBe(2);
    expect(result.outcome.review.round).toBe(3);
    expect(result.outcome.review.status).toBe('needs_human');
    expect(result.outcome.review.recommendation).toBe('human_review');
    expect(result.outcome.review.findings).toContainEqual(
      expect.objectContaining({ category: 'revision_round_limit' }),
    );
  });
});

function requestFor(scenario: GoldenSample['scenario']): ReviewRequest {
  const facts = [fact(FACT_ID, 'TypeScript')];
  const reviewJob = job();
  const reviewMaterial = material(facts[0]!);

  if (scenario === 'contradiction') {
    reviewMaterial.document.claims[0]!.citations[0]!.fact_version = 2;
  } else if (scenario === 'fabrication') {
    reviewMaterial.document.claims[0]!.text = 'TypeScript and invented quantum systems';
    reviewMaterial.document.plain_text = renderMaterialDocumentText(reviewMaterial.document);
  } else if (scenario === 'critical_missing') {
    reviewJob.description_status = 'missing';
  } else if (scenario === 'evidence_conflict') {
    const conflictingFact = fact(SECOND_FACT_ID, 'Rust');
    facts.push(conflictingFact);
    reviewMaterial.document.claims[0]!.citations.push({
      fact_id: conflictingFact.id,
      fact_version: conflictingFact.version,
      claim_path: 'value.name',
    });
    reviewMaterial.document.claims[0]!.text = 'TypeScript | Rust';
    reviewMaterial.document.plain_text = renderMaterialDocumentText(reviewMaterial.document);
  } else if (scenario === 'authorization_conflict') {
    facts.push(
      workAuthorizationFact(SECOND_FACT_ID, 'authorized'),
      workAuthorizationFact(THIRD_FACT_ID, 'requires_sponsorship'),
    );
  } else if (scenario === 'risk_review') {
    reviewJob.status = 'risk_review';
  }

  return {
    user_id: USER_ID,
    job: reviewJob,
    materials: [reviewMaterial],
    facts,
    requirements: {
      required_skills: ['TypeScript'],
      experience_keywords: [],
      work_authorization: 'not_required',
    },
    required_material_kinds: ['resume'],
    evaluated_at: NOW,
    execution: structuredClone(DEFAULT_REVIEW_EXECUTION_CONFIGURATION),
  };
}

function normalizeGoldenMessage(message: string): string {
  return message.trim().replace(/\s+/gu, ' ');
}

function job(): Job {
  return {
    id: JOB_ID,
    canonical_url: 'https://careers.example.test/jobs/backend',
    source: 'company_careers',
    source_refs: [],
    title: 'Backend Engineer',
    company: 'Example Co',
    location: 'Remote',
    employment_type: 'full_time',
    description_status: 'complete',
    risk: { level: 'low', reasons: [], requires_manual_review: false },
    status: 'active',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function fact(id: string, name: string): Fact {
  return {
    id,
    user_id: USER_ID,
    kind: 'skill',
    value: { name },
    scope: { use: 'all_goals' },
    status: 'active',
    source: { type: 'user', reference: 'review-golden-fixture' },
    confirmed_at: NOW,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function workAuthorizationFact(id: string, status: string): Fact {
  return {
    ...fact(id, status),
    kind: 'work_authorization',
    value:
      status === 'authorized'
        ? { jurisdiction: 'unspecified', authorized: true }
        : { jurisdiction: 'unspecified', requires_sponsorship: true },
  };
}

function material(sourceFact: Fact): Material {
  const claimId = `${sourceFact.id}:v1:name`;
  const document: MaterialDocument = {
    kind: 'resume',
    title: 'Resume',
    sections: [{ key: 'skill', heading: 'Skills', claim_ids: [claimId] }],
    claims: [
      {
        id: claimId,
        text: String(sourceFact.value.name),
        status: 'verified',
        citations: [
          { fact_id: sourceFact.id, fact_version: sourceFact.version, claim_path: 'value.name' },
        ],
      },
    ],
    plain_text: '',
  };
  document.plain_text = renderMaterialDocumentText(document);
  return {
    id: MATERIAL_ID,
    user_id: USER_ID,
    job_id: JOB_ID,
    kind: 'resume',
    status: 'review_required',
    version: 1,
    file_ids: [],
    fact_citations: document.claims[0]!.citations.map((citation) => ({ ...citation })),
    document,
    checks: {
      word_count: 2,
      character_count: document.plain_text.length,
      ats_compatible: true,
      has_placeholders: false,
      publishable: true,
      issues: [],
    },
    generation: {
      strategy: 'deterministic_fact_template',
      external_model_calls: 0,
      input_characters: 10,
      output_characters: document.plain_text.length,
      estimated_input_tokens: 3,
      estimated_output_tokens: 3,
    },
    created_at: NOW,
    updated_at: NOW,
  };
}

function rejectingReviewer(reviewer: RequiredReviewer): ReviewerAgent {
  return {
    reviewer,
    async review(): Promise<ReviewerReport> {
      throw new Error('fixture reviewer unavailable');
    },
  };
}

function scriptedReviewer(
  reviewer: RequiredReviewer,
  findings: () => ReviewerFindingDraft[],
): ReviewerAgent {
  return {
    reviewer,
    async review(_context, configuration: ReviewerExecutionConfiguration): Promise<ReviewerReport> {
      return { reviewer, configuration_id: configuration.configuration_id, findings: findings() };
    },
  };
}

function autoFinding(message: string): ReviewerFindingDraft {
  return {
    severity: 'warning',
    category: 'safe_style_revision',
    message,
    evidence_refs: [{ type: 'material', id: MATERIAL_ID, version: 1 }],
    disposition: 'auto_revision',
  };
}

function withReviewer(
  reviewers: readonly ReviewerAgent[],
  replacement: ReviewerAgent,
): ReviewerAgent[] {
  return reviewers.map((reviewer) =>
    reviewer.reviewer === replacement.reviewer ? replacement : reviewer,
  );
}

function stripRoundAndId(request: ReviewRequest): Omit<ReviewRequest, 'round' | 'review_id'> {
  const { round: _round, review_id: _reviewId, ...cycleRequest } = request;
  return cycleRequest;
}

function deterministicDependencies() {
  let id = 0;
  return {
    clock: () => NOW,
    idFactory: () => `90000000-0000-4000-8000-${(++id).toString().padStart(12, '0')}`,
  };
}
