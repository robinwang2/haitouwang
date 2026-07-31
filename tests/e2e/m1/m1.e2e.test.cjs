const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, test } = require('node:test');

const {
  InMemoryProfileStore,
  ProfileService,
} = require('../../../services/api/dist/modules/profile');
const { runJobImportPipeline } = require('../../../services/api/dist/modules/jobs');
const { scoreMatch } = require('../../../services/api/dist/modules/matching');

const NOW = '2026-07-30T12:00:00.000Z';
const FIXTURE_DIRECTORY = join(__dirname, '../../../services/api/tests/jobs/fixtures');
const SOURCE_FIXTURES = [
  ['greenhouse', 'greenhouse.json'],
  ['lever', 'lever.json'],
  ['company_careers', 'careers.json'],
  ['manual_url', 'manual-url.json'],
];

function readFixture(fileName) {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, fileName), 'utf8'));
}

function readSourceFixtures() {
  return SOURCE_FIXTURES.map(([, fileName]) => readFixture(fileName));
}

function profileFixture() {
  const userId = randomUUID();
  const service = new ProfileService(new InMemoryProfileStore());
  let sequence = 0;
  const context = () => {
    sequence += 1;
    return {
      actor_id: userId,
      request_id: randomUUID(),
      correlation_id: randomUUID(),
      idempotency_key: `m1-e2e-profile-${sequence.toString().padStart(6, '0')}`,
    };
  };
  return { userId, service, context };
}

function createGoal(service, userId, context, overrides = {}) {
  return service.createGoal(
    userId,
    {
      name: 'M1 software roles',
      title_keywords: ['Senior Software Engineer'],
      locations: ['New York, NY'],
      employment_types: ['full_time'],
      salary: {
        currency: 'USD',
        minimum: 150000,
        maximum: 230000,
        period: 'year',
      },
      work_authorization_rule: 'requires_sponsorship',
      locale: 'en-US',
      status: 'active',
      ...overrides,
    },
    context(),
  );
}

function createConfirmedFacts(service, userId, context) {
  const facts = [
    ['skill', { name: 'TypeScript' }],
    ['skill', { name: 'Node.js' }],
    [
      'experience',
      {
        summary: 'distributed systems, architecture reviews, mentoring, operational quality',
      },
    ],
    ['work_authorization', { jurisdiction: 'US', requires_sponsorship: true }],
  ];
  return facts.map(([kind, value]) =>
    service.createFact(
      userId,
      {
        kind,
        value,
        scope: { use: 'all_goals' },
        source: { type: 'user', reference: 'm1-e2e-profile' },
        user_confirmed: true,
      },
      context(),
    ),
  );
}

function matchingInput({
  userId,
  goal,
  job,
  facts,
  workAuthorization,
  requiredSkills = ['TypeScript', 'Node.js'],
  experienceKeywords = [
    'distributed systems',
    'architecture reviews',
    'mentoring',
    'operational quality',
  ],
}) {
  return {
    user_id: userId,
    goal,
    job,
    facts,
    requirements: {
      required_skills: requiredSkills,
      experience_keywords: experienceKeywords,
      work_authorization: workAuthorization,
    },
    context: {
      blacklisted_companies: [],
      blacklisted_title_keywords: [],
      already_applied_job_ids: [],
    },
    evaluated_at: NOW,
  };
}

function gate(score, name) {
  const result = score.hard_gates.find((item) => item.name === name);
  assert.ok(result, `missing ${name} hard gate`);
  return result;
}

describe('M1 public-module black-box acceptance', () => {
  test('all four fixed source fixtures parse through the public import pipeline', () => {
    for (const [expectedSource, fileName] of SOURCE_FIXTURES) {
      const jobs = runJobImportPipeline([readFixture(fileName)], { now: NOW });
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].source, expectedSource);
      assert.deepEqual(
        jobs[0].source_refs.map((sourceRef) => sourceRef.type),
        [expectedSource],
      );
      assert.match(jobs[0].source_refs[0].content_hash, /^[a-f0-9]{64}$/);
    }
  });

  test('profile facts, four-source deduplication and scoring form an eligible closed loop', () => {
    const { userId, service, context } = profileFixture();
    const goal = createGoal(service, userId, context);
    createConfirmedFacts(service, userId, context);

    const jobs = runJobImportPipeline(readSourceFixtures(), { now: NOW });
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      [...new Set(jobs.flatMap((job) => job.source_refs.map((ref) => ref.type)))].sort(),
      ['company_careers', 'greenhouse', 'lever', 'manual_url'],
    );

    const canonical = jobs.find((job) => job.title === 'Senior Software Engineer');
    assert.ok(canonical);
    assert.equal(canonical.source, 'company_careers');
    assert.equal(
      canonical.canonical_url,
      'https://careers.acme.example/jobs/senior-software-engineer',
    );
    assert.deepEqual(
      canonical.source_refs.map((sourceRef) => sourceRef.type),
      ['company_careers', 'greenhouse', 'lever'],
    );
    assert.equal(canonical.status, 'active');
    assert.equal(canonical.risk.level, 'low');

    const expired = jobs.find((job) => job.source === 'manual_url');
    assert.ok(expired);
    assert.equal(expired.status, 'expired');

    const usableFacts = service.listUsableFacts(userId, goal.id);
    assert.equal(usableFacts.length, 4);
    const score = scoreMatch(
      matchingInput({
        userId,
        goal,
        job: canonical,
        facts: usableFacts,
        workAuthorization: 'sponsorship_available',
      }),
    );

    assert.equal(score.total, 100);
    assert.equal(score.decision, 'eligible');
    assert.equal(score.hard_gates.length, 7);
    assert.ok(score.hard_gates.every((item) => item.result === 'pass'));
    assert.equal(score.dimensions.length, 7);
    assert.ok(score.explanations.every((explanation) => explanation.includes('[')));
  });

  test('unavailable sponsorship blocks an otherwise high-scoring job', () => {
    const { userId, service, context } = profileFixture();
    const goal = createGoal(service, userId, context);
    createConfirmedFacts(service, userId, context);
    const [canonical] = runJobImportPipeline(readSourceFixtures().slice(0, 3), { now: NOW });

    const score = scoreMatch(
      matchingInput({
        userId,
        goal,
        job: canonical,
        facts: service.listUsableFacts(userId, goal.id),
        workAuthorization: 'sponsorship_unavailable',
      }),
    );

    assert.equal(score.total, 85);
    assert.equal(gate(score, 'work_authorization').result, 'block');
    assert.equal(score.decision, 'blocked');
    assert.ok(
      score.explanations.some(
        (explanation) =>
          explanation.includes('work_authorization is block') &&
          explanation.includes('goal.work_authorization_rule'),
      ),
    );
  });

  test('high-risk import is routed to review and its risk gate blocks a perfect score', () => {
    const { userId, service, context } = profileFixture();
    const goal = createGoal(service, userId, context, {
      name: 'M1 support roles',
      title_keywords: ['Support Specialist'],
      locations: ['Remote'],
      salary: undefined,
      work_authorization_rule: 'authorized',
    });
    const [job] = runJobImportPipeline(
      [
        {
          source: 'manual_url',
          url: 'http://jobs.example.test/support-specialist?utm_source=message',
          fetched_at: '2026-07-29T08:00:00.000Z',
          payload: {
            '@type': 'JobPosting',
            identifier: 'SUPPORT-9',
            title: 'Support Specialist',
            hiringOrganization: { name: 'Example Test' },
            jobLocation: { address: { addressLocality: 'Remote' } },
            employmentType: 'FULL_TIME',
            description:
              'Contact our recruiter on Telegram and pay an application fee before the interview. We will send the complete responsibilities after you make the deposit.',
            validThrough: '2026-08-30T00:00:00.000Z',
          },
        },
      ],
      { now: NOW },
    );

    assert.equal(job.status, 'risk_review');
    assert.deepEqual(job.risk, {
      level: 'high',
      reasons: [
        'description_partial',
        'insecure_posting_url',
        'payment_requested',
        'personal_messaging_contact',
      ],
      requires_manual_review: true,
    });

    const score = scoreMatch(
      matchingInput({
        userId,
        goal,
        job,
        facts: [],
        workAuthorization: 'not_required',
        requiredSkills: [],
        experienceKeywords: [],
      }),
    );

    assert.equal(score.total, 100);
    assert.equal(gate(score, 'risk').result, 'block');
    assert.equal(score.decision, 'blocked');
    assert.ok(
      score.explanations.some(
        (explanation) =>
          explanation.includes('risk is block') && explanation.includes('job.risk.level'),
      ),
    );
  });
});
