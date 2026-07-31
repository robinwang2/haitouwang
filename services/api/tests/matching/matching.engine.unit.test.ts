import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MATCHING_WEIGHTS,
  classifyMatchScore,
  scoreMatch,
  type HardGateName,
  type MatchBand,
  type MatchingInput,
} from '../../src/modules/matching';
import type { Job } from '../../src/modules/jobs';
import type { Fact, Goal } from '../../src/modules/profile';

const NOW = '2026-07-30T12:00:00.000Z';
const USER_ID = '10000000-0000-4000-8000-000000000001';
const GOAL_ID = '20000000-0000-4000-8000-000000000002';
const JOB_ID = '30000000-0000-4000-8000-000000000003';
const SKILLS = ['TypeScript', 'Node.js', 'PostgreSQL', 'AWS'];
const EXPERIENCE = ['APIs', 'distributed systems', 'mentoring', 'observability'];

interface GoldenSample {
  name: string;
  skill_matches: number;
  experience_matches: number;
  preference_match: boolean;
  expected_total: number;
  expected_band: MatchBand;
}

function readGoldenSamples(): GoldenSample[] {
  const path = fileURLToPath(
    new URL('./fixtures/golden-samples.json', import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenSample[];
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: GOAL_ID,
    user_id: USER_ID,
    name: 'Backend roles',
    title_keywords: ['Backend Engineer'],
    locations: ['Remote'],
    employment_types: ['full_time'],
    salary: {
      currency: 'USD',
      minimum: 150000,
      maximum: 220000,
      period: 'year',
    },
    work_authorization_rule: 'authorized',
    status: 'active',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    canonical_url: 'https://careers.example.test/jobs/backend-engineer',
    source: 'company_careers',
    source_refs: [],
    title: 'Backend Engineer',
    company: 'Example Co',
    location: 'Remote',
    employment_type: 'full_time',
    salary: {
      currency: 'USD',
      minimum: 175000,
      maximum: 210000,
      period: 'year',
    },
    description_status: 'complete',
    risk: {
      level: 'low',
      reasons: [],
      requires_manual_review: false,
    },
    status: 'active',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function fact(
  id: number,
  kind: Fact['kind'],
  value: Fact['value'],
  overrides: Partial<Fact> = {},
): Fact {
  return {
    id: `40000000-0000-4000-8000-${id.toString().padStart(12, '0')}`,
    user_id: USER_ID,
    kind,
    value,
    scope: { use: 'all_goals' },
    status: 'active',
    source: { type: 'user', reference: 'matching-test' },
    confirmed_at: NOW,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function matchingInput(overrides: Partial<MatchingInput> = {}): MatchingInput {
  return {
    user_id: USER_ID,
    goal: goal(),
    job: job(),
    facts: [
      ...SKILLS.map((name, index) => fact(index + 1, 'skill', { name })),
      fact(10, 'experience', {
        summary: EXPERIENCE.join(', '),
      }),
    ],
    requirements: {
      required_skills: SKILLS,
      experience_keywords: EXPERIENCE,
      work_authorization: 'not_required',
    },
    context: {
      blacklisted_companies: [],
      blacklisted_title_keywords: [],
      already_applied_job_ids: [],
    },
    evaluated_at: NOW,
    ...overrides,
  };
}

describe('matching weights and golden samples', () => {
  it('keeps the frozen seven-dimension weights at exactly 100', () => {
    expect(MATCHING_WEIGHTS).toEqual({
      skills: 25,
      experience: 20,
      work_authorization: 15,
      location: 15,
      salary: 10,
      employment_type: 10,
      preference: 5,
    });
    expect(
      Object.values(MATCHING_WEIGHTS).reduce((sum, weight) => sum + weight, 0),
    ).toBe(100);
  });

  it.each(readGoldenSamples())(
    'replays the $name score band golden sample',
    (sample) => {
      const availableSkills = SKILLS.slice(0, sample.skill_matches);
      const availableExperience = EXPERIENCE.slice(
        0,
        sample.experience_matches,
      );
      const input = matchingInput({
        goal: goal({
          title_keywords: sample.preference_match
            ? ['Backend Engineer']
            : ['Product Designer'],
        }),
        facts: [
          ...availableSkills.map((name, index) =>
            fact(index + 1, 'skill', { name }),
          ),
          fact(10, 'experience', {
            summary: availableExperience.join(', '),
          }),
        ],
      });

      const first = scoreMatch(input);
      const replay = scoreMatch(structuredClone(input));

      expect(first).toEqual(replay);
      expect(first.total).toBe(sample.expected_total);
      expect(classifyMatchScore(first.total)).toBe(sample.expected_band);
      expect(first.decision).toBe('eligible');
      expect(first.dimensions).toHaveLength(7);
      expect(first.hard_gates).toHaveLength(7);
      expect(first.input_version).toMatch(/^[a-f0-9]{64}$/);
      expect(first.explanations.every((item) => item.includes('['))).toBe(true);
    },
  );
});

describe('hard-rule precedence', () => {
  const blockingCases: {
    name: HardGateName;
    mutate: (input: MatchingInput) => MatchingInput;
  }[] = [
    {
      name: 'work_authorization',
      mutate: (input) => ({
        ...input,
        goal: goal({ work_authorization_rule: 'requires_sponsorship' }),
        requirements: {
          ...input.requirements,
          work_authorization: 'sponsorship_unavailable',
        },
      }),
    },
    {
      name: 'blacklist',
      mutate: (input) => ({
        ...input,
        context: {
          ...input.context,
          blacklisted_companies: ['Example Co'],
        },
      }),
    },
    {
      name: 'duplicate',
      mutate: (input) => ({
        ...input,
        context: {
          ...input.context,
          already_applied_job_ids: [JOB_ID],
        },
      }),
    },
    {
      name: 'location',
      mutate: (input) => ({
        ...input,
        job: job({ location: 'Seattle, WA' }),
      }),
    },
    {
      name: 'salary',
      mutate: (input) => ({
        ...input,
        job: job({
          salary: {
            currency: 'USD',
            minimum: 90000,
            maximum: 120000,
            period: 'year',
          },
        }),
      }),
    },
    {
      name: 'employment_type',
      mutate: (input) => ({
        ...input,
        job: job({ employment_type: 'contract' }),
      }),
    },
    {
      name: 'risk',
      mutate: (input) => ({
        ...input,
        job: job({
          risk: {
            level: 'high',
            reasons: ['payment_requested'],
            requires_manual_review: true,
          },
        }),
      }),
    },
  ];

  it.each(blockingCases)(
    'blocks the $name hard gate even with a perfect weighted score',
    ({ name, mutate }) => {
      const result = scoreMatch(
        Object.assign(mutate(matchingInput()), {
          model_decision_override: 'eligible',
          model_score_override: 100,
        }) as MatchingInput,
      );

      expect(result.hard_gates.find((gate) => gate.name === name)?.result).toBe(
        'block',
      );
      expect(result.decision).toBe('blocked');
      expect(result.explanations).toContainEqual(
        expect.stringContaining(`recommendation: ${name} is block`),
      );
    },
  );

  it('routes unknown hard-rule evidence to manual review', () => {
    const result = scoreMatch(
      matchingInput({
        goal: goal({ work_authorization_rule: 'unknown' }),
        job: job({
          location: 'Unknown',
          employment_type: 'unknown',
          salary: undefined,
          risk: {
            level: 'unknown',
            reasons: ['insufficient_evidence'],
            requires_manual_review: true,
          },
        }),
      }),
    );

    expect(result.decision).toBe('manual_review');
    expect(result.hard_gates.filter((gate) => gate.result === 'manual')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'work_authorization' }),
        expect.objectContaining({ name: 'location' }),
        expect.objectContaining({ name: 'salary' }),
        expect.objectContaining({ name: 'employment_type' }),
        expect.objectContaining({ name: 'risk' }),
      ]),
    );
  });

  it('never uses unavailable facts in a score or its trace', () => {
    const input = matchingInput({
      facts: [
        fact(1, 'skill', { name: 'TypeScript' }),
        fact(2, 'skill', { name: 'Node.js' }, { status: 'pending_confirmation' }),
        fact(
          3,
          'skill',
          { name: 'PostgreSQL' },
          { scope: { use: 'manual_only' } },
        ),
        fact(
          4,
          'skill',
          { name: 'AWS' },
          { valid_until: '2026-07-29T12:00:00.000Z' },
        ),
      ],
    });

    expect(
      scoreMatch(input).dimensions.find((item) => item.name === 'skills')?.score,
    ).toBe(25);
  });
});
