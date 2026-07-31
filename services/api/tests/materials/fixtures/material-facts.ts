import type { Fact } from '../../../src/modules/profile';

export const NOW = '2026-07-31T12:00:00.000Z';
export const USER_ID = '10000000-0000-4000-8000-000000000001';
export const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
export const GOAL_ID = '20000000-0000-4000-8000-000000000001';
export const OTHER_GOAL_ID = '20000000-0000-4000-8000-000000000002';

export function materialFacts(): Fact[] {
  return [
    fact(1, 'identity', { name: 'Ada Lovelace' }),
    fact(2, 'contact', { email: 'ada@example.test' }),
    fact(3, 'summary', { summary: 'Backend engineer focused on reliable systems.' }),
    fact(4, 'experience', {
      company: 'Analytical Engines LLC',
      role: 'Software Engineer',
      start_date: '2021-03',
      end_date: '2024-06',
      achievement: 'Reduced batch processing time by 35%.',
    }),
    fact(5, 'education', {
      school: 'Rochester Institute of Technology',
      degree: 'Master of Science in Computer Science',
      gpa: '3.90',
      graduation_date: '2021-05',
    }),
    fact(6, 'skill', { name: 'TypeScript' }),
    fact(7, 'skill', { name: 'PostgreSQL' }),
    fact(8, 'project', {
      name: 'Application Tracker',
      result: 'Processed 10,000 records per hour.',
    }),
  ];
}

export function fact(
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
    source: { type: 'file', reference: `resume:${id}` },
    confirmed_at: '2026-07-30T12:00:00.000Z',
    version: 1,
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}
