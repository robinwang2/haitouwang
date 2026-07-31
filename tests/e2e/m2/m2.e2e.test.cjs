const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, test } = require('node:test');

const { runJobImportPipeline } = require('../../../services/api/dist/modules/jobs');
const {
  MaterialsService,
  renderMaterialDocumentText,
} = require('../../../services/api/dist/modules/materials');
const {
  DEFAULT_REVIEW_EXECUTION_CONFIGURATION,
  createDefaultReviewers,
  runReview,
  runReviewCycle,
} = require('../../../services/api/dist/modules/review');
const {
  InMemoryProfileStore,
  ProfileService,
} = require('../../../services/api/dist/modules/profile');

const NOW = '2026-07-31T12:00:00.000Z';
const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const JOB_ID = '20000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '30000000-0000-4000-8000-000000000001';
const GOLDEN_PATH = join(__dirname, 'fixtures/golden-samples.json');

function executionConfiguration() {
  return structuredClone(DEFAULT_REVIEW_EXECUTION_CONFIGURATION);
}

function sequenceFactory(prefix = '90000000-0000-4000-8000-') {
  let sequence = 0;
  return () => `${prefix}${(++sequence).toString().padStart(12, '0')}`;
}

function requestContext(userId) {
  let sequence = 0;
  return () => ({
    actor_id: userId,
    request_id: randomUUID(),
    correlation_id: randomUUID(),
    idempotency_key: `m2-e2e-profile-${(++sequence).toString().padStart(6, '0')}`,
  });
}

function importedJob(overrides = {}) {
  const [job] = runJobImportPipeline(
    [
      {
        source: 'company_careers',
        url: 'https://careers.example.test/jobs/platform-engineer',
        fetched_at: NOW,
        payload: {
          '@type': 'JobPosting',
          identifier: 'PLATFORM-1',
          title: 'Platform Engineer',
          hiringOrganization: { name: 'Example Test' },
          jobLocation: { address: { addressLocality: 'Remote' } },
          employmentType: 'FULL_TIME',
          description:
            'Build reliable TypeScript services and distributed systems. Partner with product, security, and infrastructure teams, improve deployment safety and observability, review architecture, mentor engineers, and maintain operational quality.',
          validThrough: '2026-08-31T00:00:00.000Z',
        },
      },
    ],
    { now: NOW },
  );
  return { ...job, ...overrides };
}

function requirements() {
  return {
    required_skills: ['TypeScript'],
    experience_keywords: ['distributed systems'],
    work_authorization: 'not_required',
  };
}

function reviewRequest({ userId = USER_ID, job, materials, facts, goalId }) {
  return {
    user_id: userId,
    ...(goalId ? { goal_id: goalId } : {}),
    job,
    materials,
    facts,
    requirements: requirements(),
    required_material_kinds: ['resume'],
    evaluated_at: NOW,
    execution: executionConfiguration(),
  };
}

function factFromFixture(input, userId = USER_ID) {
  return {
    id: input.id,
    user_id: userId,
    kind: input.kind,
    value: structuredClone(input.value),
    scope: { use: 'all_goals' },
    status: 'active',
    source: { type: 'user', reference: 'm2-golden-fixture' },
    confirmed_at: NOW,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function goldenSamples() {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
}

function finalDisposition(outcome) {
  if (outcome.review.recommendation === 'approve') return 'approval_candidate';
  if (outcome.review.recommendation === 'human_review') return 'human_review';
  return 'blocked';
}

function assertFindingTrace(outcome, facts, materials, job) {
  const known = new Set([
    ...facts.map((fact) => `fact:${fact.id}:${fact.version}`),
    ...materials.map((material) => `material:${material.id}:${material.version}`),
    `job:${job.id}:${job.version}`,
  ]);
  for (const finding of outcome.review.findings) {
    assert.ok(finding.evidence_refs.length > 0, `${finding.category} must retain evidence`);
    for (const reference of finding.evidence_refs) {
      assert.ok(
        known.has(`${reference.type}:${reference.id}:${reference.version}`),
        `${finding.category} has an unresolved evidence reference`,
      );
    }
  }
}

describe('M2 facts-to-human-approval closed loop', () => {
  test('real confirmed facts, job requirements, generation, isolated review, one revision and explicit approval form a repeatable path', async () => {
    const profiles = new ProfileService(new InMemoryProfileStore());
    const context = requestContext(USER_ID);
    const goal = profiles.createGoal(
      USER_ID,
      {
        name: 'M2 platform roles',
        title_keywords: ['Platform Engineer'],
        locations: ['Remote'],
        employment_types: ['full_time'],
        work_authorization_rule: 'authorized',
        locale: 'en-US',
        status: 'active',
      },
      context(),
    );
    const factInputs = [
      ['skill', { name: 'TypeScript' }],
      ['experience', { summary: 'Built distributed systems with measurable reliability.' }],
      [
        'summary',
        {
          text: 'Builds reliable systems for customers. Builds reliable systems for customers.',
        },
      ],
    ];
    const facts = factInputs.map(([kind, value]) =>
      profiles.createFact(
        USER_ID,
        {
          kind,
          value,
          scope: { use: 'selected_goals', goal_ids: [goal.id] },
          source: { type: 'user', reference: 'm2-e2e-confirmed-input' },
          user_confirmed: true,
        },
        context(),
      ),
    );
    const usableFacts = profiles.listUsableFacts(USER_ID, goal.id, NOW);
    assert.deepEqual(
      new Set(usableFacts.map((fact) => fact.id)),
      new Set(facts.map((fact) => fact.id)),
    );

    const job = importedJob();
    const materialIds = sequenceFactory('31000000-0000-4000-8000-');
    const materials = new MaterialsService(() => NOW, materialIds);
    const draft = materials.generate({
      id: MATERIAL_ID,
      user_id: USER_ID,
      job_id: job.id,
      goal_id: goal.id,
      kind: 'resume',
      facts: usableFacts,
      evaluated_at: NOW,
    });
    assert.equal(draft.status, 'review_required');
    assert.equal(draft.checks.publishable, true);
    assert.equal(draft.generation.external_model_calls, 0);

    let revisedMaterial;
    const revisionAgent = {
      configuration: executionConfiguration().generator,
      async revise(reviewContext, findings, nextRound) {
        assert.equal(nextRound, 2);
        assert.ok(findings.some((finding) => finding.category === 'repetitive_language'));
        const summaryFact = usableFacts.find((fact) => fact.kind === 'summary');
        revisedMaterial = materials.revise(USER_ID, draft.id, draft.version, {
          goal_id: goal.id,
          facts: usableFacts,
          fact_ids: usableFacts.filter((fact) => fact.id !== summaryFact.id).map((fact) => fact.id),
          evaluated_at: NOW,
        });
        return { ...structuredClone(reviewContext), materials: [revisedMaterial] };
      },
    };

    const cycle = await runReviewCycle(
      reviewRequest({
        job,
        materials: [draft],
        facts: usableFacts,
        goalId: goal.id,
      }),
      revisionAgent,
      createDefaultReviewers(),
      { clock: () => NOW, idFactory: sequenceFactory() },
    );

    assert.equal(cycle.rounds.length, 2);
    assert.equal(cycle.automatic_revisions, 1);
    assert.equal(cycle.rounds[0].review.status, 'requires_changes');
    assert.equal(cycle.outcome.review.status, 'approved');
    assert.equal(cycle.outcome.review.recommendation, 'approve');
    assert.deepEqual(cycle.outcome.review.reviewers, [
      'ats',
      'hard_requirements',
      'fact_check',
      'naturalness',
    ]);
    assert.equal(new Set(cycle.outcome.reports.map((report) => report.configuration_id)).size, 4);
    assert.ok(
      cycle.outcome.reports.every(
        (report) =>
          report.configuration_id !==
          DEFAULT_REVIEW_EXECUTION_CONFIGURATION.generator.configuration_id,
      ),
    );

    const approved = materials.approve(
      USER_ID,
      revisedMaterial.id,
      revisedMaterial.version,
      usableFacts,
      NOW,
      goal.id,
    );
    assert.equal(approved.status, 'approved');
    assert.equal(approved.version, 3);
    assert.ok(
      approved.document.claims.every(
        (claim) =>
          claim.status === 'verified' &&
          claim.citations.length > 0 &&
          claim.citations.every((citation) =>
            usableFacts.some(
              (fact) => fact.id === citation.fact_id && fact.version === citation.fact_version,
            ),
          ),
      ),
    );
    assert.deepEqual(
      materials.getAuditEvents(USER_ID).map((event) => event.action),
      ['material.draft_created', 'material.draft_revised', 'material.approved'],
    );
  });
});

describe('M2 traceable AI golden evaluation', () => {
  for (const sample of goldenSamples()) {
    test(`${sample.id}: ${sample.scenario}`, async () => {
      const facts = sample.input_facts.map((input) => factFromFixture(input));
      const job = importedJob();
      const materialsService = new MaterialsService(
        () => NOW,
        sequenceFactory('32000000-0000-4000-8000-'),
      );
      const generationInput = {
        id: `50000000-0000-4000-8000-${sample.id
          .split('')
          .reduce((sum, character) => sum + character.charCodeAt(0), 0)
          .toString()
          .padStart(12, '0')}`,
        user_id: USER_ID,
        job_id: job.id,
        kind: 'resume',
        facts,
        evaluated_at: NOW,
      };
      if (sample.scenario === 'prompt_injection') {
        generationInput.pending_claims = [{ text: sample.untrusted_prompt }];
      }
      const stored = materialsService.generate(generationInput);
      const reviewMaterial = structuredClone(stored);
      const reviewJob = structuredClone(job);

      if (sample.scenario === 'contradiction') {
        reviewMaterial.document.claims[0].citations[0].fact_version += 1;
      } else if (sample.scenario === 'fabrication') {
        reviewMaterial.document.claims[0].text =
          'TypeScript and an invented ten-year Kubernetes achievement';
        reviewMaterial.document.plain_text = renderMaterialDocumentText(reviewMaterial.document);
      } else if (sample.scenario === 'critical_missing') {
        reviewJob.description_status = 'missing';
      } else if (sample.scenario === 'evidence_conflict') {
        reviewMaterial.document.claims[0].citations.push({
          fact_id: facts[1].id,
          fact_version: facts[1].version,
          claim_path: 'value.name',
        });
        reviewMaterial.document.claims[0].text = 'TypeScript | Rust';
        reviewMaterial.document.plain_text = renderMaterialDocumentText(reviewMaterial.document);
      }

      const outcome = await runReview(
        reviewRequest({ job: reviewJob, materials: [reviewMaterial], facts }),
        createDefaultReviewers(),
        { clock: () => NOW, idFactory: sequenceFactory() },
      );

      assert.equal(outcome.review.status, sample.expected.status);
      assert.equal(outcome.review.recommendation, sample.expected.recommendation);
      assert.equal(finalDisposition(outcome), sample.expected.final_disposition);
      assert.deepEqual(
        facts.map((fact) => fact.id),
        sample.input_facts.map((fact) => fact.id),
      );
      assert.ok(
        reviewMaterial.document.claims
          .filter((claim) => claim.status === 'verified')
          .every(
            (claim) =>
              claim.citations.length > 0 &&
              claim.citations.every((citation) =>
                facts.some((fact) => fact.id === citation.fact_id),
              ),
          ),
        `${sample.id} claims must trace back to fixture facts`,
      );
      assertFindingTrace(outcome, facts, [reviewMaterial], reviewJob);

      if (sample.expected.category) {
        const finding = outcome.review.findings.find(
          (candidate) => candidate.category === sample.expected.category,
        );
        assert.ok(finding, `${sample.id} must produce ${sample.expected.category}`);
        assert.ok(outcome.summary[sample.expected.bucket].includes(finding.id));
        assert.notEqual(outcome.review.recommendation, 'approve');
      } else {
        assert.deepEqual(outcome.review.findings, []);
      }

      if (sample.scenario === 'prompt_injection') {
        assert.equal(stored.checks.publishable, false);
        assert.ok(stored.checks.issues.some((issue) => issue.code === 'PENDING_CONFIRMATION'));
        assert.ok(
          stored.document.claims
            .filter((claim) => claim.status === 'verified')
            .every((claim) => claim.text !== sample.untrusted_prompt),
        );
        assert.throws(
          () => materialsService.approve(USER_ID, stored.id, stored.version, facts, NOW),
          (error) => error.code === 'MATERIAL_NOT_PUBLISHABLE',
        );
      }
    });
  }
});

describe('M2 safety degradation and authorization boundaries', () => {
  test('cross-user fact selection, material access and review are denied', async () => {
    const ownerFact = factFromFixture({
      id: '47000000-0000-4000-8000-000000000001',
      kind: 'skill',
      value: { name: 'TypeScript' },
    });
    const job = importedJob();
    const materials = new MaterialsService(() => NOW, sequenceFactory());
    const ownerMaterial = materials.generate({
      id: MATERIAL_ID,
      user_id: USER_ID,
      job_id: job.id,
      kind: 'resume',
      facts: [ownerFact],
      evaluated_at: NOW,
    });

    assert.throws(
      () =>
        materials.generate({
          user_id: OTHER_USER_ID,
          job_id: job.id,
          kind: 'resume',
          facts: [ownerFact],
          fact_ids: [ownerFact.id],
          evaluated_at: NOW,
        }),
      (error) => error.code === 'RESOURCE_NOT_FOUND',
    );
    assert.throws(
      () => materials.get(OTHER_USER_ID, ownerMaterial.id),
      (error) => error.code === 'RESOURCE_NOT_FOUND',
    );
    await assert.rejects(
      runReview(
        reviewRequest({
          userId: OTHER_USER_ID,
          job,
          materials: [ownerMaterial],
          facts: [ownerFact],
        }),
      ),
      (error) => error.code === 'VALIDATION_FAILED',
    );
  });

  test('an unavailable reviewer stops automatic progress and routes to a person', async () => {
    const facts = [
      factFromFixture({
        id: '48000000-0000-4000-8000-000000000001',
        kind: 'skill',
        value: { name: 'TypeScript' },
      }),
    ];
    const job = importedJob();
    const materials = new MaterialsService(() => NOW, sequenceFactory());
    const material = materials.generate({
      id: MATERIAL_ID,
      user_id: USER_ID,
      job_id: job.id,
      kind: 'resume',
      facts,
      evaluated_at: NOW,
    });
    const reviewers = createDefaultReviewers().map((reviewer) =>
      reviewer.reviewer === 'fact_check'
        ? {
            reviewer: 'fact_check',
            async review() {
              throw new Error('model unavailable fixture');
            },
          }
        : reviewer,
    );
    let revisionCalled = false;
    const cycle = await runReviewCycle(
      reviewRequest({ job, materials: [material], facts }),
      {
        configuration: executionConfiguration().generator,
        async revise(context) {
          revisionCalled = true;
          return context;
        },
      },
      reviewers,
      { clock: () => NOW, idFactory: sequenceFactory() },
    );

    assert.equal(cycle.rounds.length, 1);
    assert.equal(cycle.automatic_revisions, 0);
    assert.equal(revisionCalled, false);
    assert.equal(cycle.outcome.review.status, 'needs_human');
    const unavailable = cycle.outcome.review.findings.find(
      (finding) => finding.category === 'reviewer_unavailable',
    );
    assert.equal(unavailable.reviewer, 'fact_check');
    assert.ok(cycle.outcome.summary.human_review.includes(unavailable.id));
  });

  test('persistent safe revisions stop after three reviews and require a person', async () => {
    const facts = [
      factFromFixture({
        id: '49000000-0000-4000-8000-000000000001',
        kind: 'skill',
        value: { name: 'TypeScript' },
      }),
    ];
    const job = importedJob();
    const materials = new MaterialsService(() => NOW, sequenceFactory());
    const material = materials.generate({
      id: MATERIAL_ID,
      user_id: USER_ID,
      job_id: job.id,
      kind: 'resume',
      facts,
      evaluated_at: NOW,
    });
    const reviewers = createDefaultReviewers().map((reviewer) =>
      reviewer.reviewer === 'naturalness'
        ? {
            reviewer: 'naturalness',
            async review(_context, configuration) {
              return {
                reviewer: 'naturalness',
                configuration_id: configuration.configuration_id,
                findings: [
                  {
                    severity: 'warning',
                    category: 'persistent_style_issue',
                    message: 'The style issue persisted after bounded automatic revision.',
                    evidence_refs: [
                      { type: 'material', id: material.id, version: material.version },
                    ],
                    disposition: 'auto_revision',
                  },
                ],
              };
            },
          }
        : reviewer,
    );
    const cycle = await runReviewCycle(
      reviewRequest({ job, materials: [material], facts }),
      {
        configuration: executionConfiguration().generator,
        async revise(context) {
          return structuredClone(context);
        },
      },
      reviewers,
      { clock: () => NOW, idFactory: sequenceFactory() },
    );

    assert.equal(cycle.rounds.length, 3);
    assert.equal(cycle.automatic_revisions, 2);
    assert.equal(cycle.outcome.review.round, 3);
    assert.equal(cycle.outcome.review.status, 'needs_human');
    assert.equal(cycle.outcome.review.recommendation, 'human_review');
    const limit = cycle.outcome.review.findings.find(
      (finding) => finding.category === 'revision_round_limit',
    );
    assert.ok(limit);
    assert.ok(cycle.outcome.summary.human_review.includes(limit.id));
  });
});
