import type { Job, Score } from './contracts';

const userId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const inputVersion = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const mockJobs: Job[] = [
  {
    id: '90000000-0000-4000-8000-000000000001',
    canonical_url: 'https://boards.greenhouse.io/northstar/jobs/74219',
    source: 'greenhouse',
    source_refs: [
      { type: 'greenhouse', reference: 'greenhouse:74219' },
      { type: 'company_careers', reference: 'https://careers.northstar.example/frontend-engineer' },
    ],
    title: 'Senior Frontend Engineer',
    company: 'Northstar',
    location: 'Seattle, WA · Hybrid',
    employment_type: 'full_time',
    description_status: 'complete',
    risk: { level: 'low', reasons: [], requires_manual_review: false },
    status: 'active',
    version: 3,
    created_at: '2026-07-30T13:10:00Z',
    updated_at: '2026-07-30T15:40:00Z',
  },
  {
    id: '90000000-0000-4000-8000-000000000002',
    canonical_url: 'https://jobs.lever.co/fieldnotes/44a201',
    source: 'lever',
    source_refs: [{ type: 'lever', reference: 'lever:44a201' }],
    title: 'Product Engineer',
    company: 'Fieldnotes',
    location: 'Remote · US',
    employment_type: 'full_time',
    description_status: 'complete',
    risk: { level: 'medium', reasons: ['work_authorization_unknown'], requires_manual_review: true },
    status: 'risk_review',
    version: 1,
    created_at: '2026-07-30T09:20:00Z',
    updated_at: '2026-07-30T09:24:00Z',
  },
  {
    id: '90000000-0000-4000-8000-000000000003',
    canonical_url: 'https://careers.redwood.example/jobs/ui-engineer',
    source: 'company_careers',
    source_refs: [{ type: 'company_careers', reference: 'careers:redwood:ui-engineer' }],
    title: 'UI Platform Engineer',
    company: 'Redwood Systems',
    location: 'San Francisco, CA · On-site',
    employment_type: 'full_time',
    description_status: 'partial',
    risk: { level: 'high', reasons: ['location_rule_blocked', 'description_partial'], requires_manual_review: true },
    status: 'active',
    version: 2,
    created_at: '2026-07-29T19:10:00Z',
    updated_at: '2026-07-30T07:40:00Z',
  },
];

const passGateNames = ['work_authorization', 'blacklist', 'duplicate', 'location', 'salary', 'employment_type', 'risk'] as const;
const dimensionSeed = [
  ['skills', 25, 92],
  ['experience', 20, 88],
  ['work_authorization', 15, 100],
  ['location', 15, 84],
  ['salary', 10, 70],
  ['employment_type', 10, 100],
  ['preference', 5, 80],
] as const;

export const mockScores: Score[] = [
  {
    id: '91000000-0000-4000-8000-000000000001',
    user_id: userId,
    goal_id: goalId,
    job_id: mockJobs[0].id,
    total: 89,
    dimensions: dimensionSeed.map(([name, weight, score]) => ({ name, weight, score, evidence_paths: [`/facts/${name}`] })),
    hard_gates: passGateNames.map((name) => ({ name, result: 'pass', evidence_paths: [`/jobs/0/${name}`] })),
    decision: 'eligible',
    explanations: [
      'Strong TypeScript and design-system evidence aligns with the core requirements.',
      'Four years of product engineering experience meets the stated seniority range.',
      'Salary range needs confirmation before material generation.',
    ],
    input_version: inputVersion,
    created_at: '2026-07-30T15:42:00Z',
  },
  {
    id: '91000000-0000-4000-8000-000000000002',
    user_id: userId,
    goal_id: goalId,
    job_id: mockJobs[1].id,
    total: 76,
    dimensions: dimensionSeed.map(([name, weight, score]) => ({
      name,
      weight,
      score: name === 'work_authorization' ? 40 : Math.max(60, score - 8),
      evidence_paths: [`/facts/${name}`],
    })),
    hard_gates: passGateNames.map((name) => ({
      name,
      result: name === 'work_authorization' ? 'manual' : 'pass',
      evidence_paths: [`/jobs/1/${name}`],
    })),
    decision: 'manual_review',
    explanations: [
      'Product engineering scope is a good fit.',
      'Work authorization wording is ambiguous and requires a user decision.',
    ],
    input_version: inputVersion,
    created_at: '2026-07-30T09:25:00Z',
  },
  {
    id: '91000000-0000-4000-8000-000000000003',
    user_id: userId,
    goal_id: goalId,
    job_id: mockJobs[2].id,
    total: 82,
    dimensions: dimensionSeed.map(([name, weight, score]) => ({
      name,
      weight,
      score: name === 'location' ? 20 : score,
      evidence_paths: [`/facts/${name}`],
    })),
    hard_gates: passGateNames.map((name) => ({
      name,
      result: name === 'location' ? 'block' : name === 'risk' ? 'manual' : 'pass',
      evidence_paths: [`/jobs/2/${name}`],
    })),
    decision: 'blocked',
    explanations: [
      'Core UI platform skills match the role.',
      'The on-site location conflicts with the active goal and blocks automation.',
    ],
    input_version: inputVersion,
    created_at: '2026-07-30T07:42:00Z',
  },
];

export async function loadJobsMock() {
  return Promise.resolve({ items: mockJobs, scores: mockScores, page: { page_size: 20 } });
}
