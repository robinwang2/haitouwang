import type { CursorPage, Fact, Goal, Material } from './contracts';

const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  goal: '20000000-0000-4000-8000-000000000001',
};

export const mockGoals: CursorPage<Goal> = {
  items: [
    {
      id: ids.goal,
      user_id: ids.user,
      name: 'Product engineering',
      title_keywords: ['Frontend Engineer', 'Product Engineer'],
      locations: ['Seattle, WA', 'Remote — US'],
      employment_types: ['full_time'],
      work_authorization_rule: 'authorized',
      locale: 'en-US',
      status: 'active',
      version: 3,
      created_at: '2026-07-22T17:20:00Z',
      updated_at: '2026-07-29T18:45:00Z',
    },
  ],
  page: { page_size: 20, next_cursor: null, total_estimate: 1 },
};

export const mockFacts: CursorPage<Fact> = {
  items: [
    {
      id: '30000000-0000-4000-8000-000000000001',
      user_id: ids.user,
      kind: 'experience',
      value: { title: 'Frontend Engineer', company: 'Northstar Labs', years: 4 },
      scope: { use: 'all_goals' },
      status: 'active',
      source: { type: 'file', reference: 'resume-v3.pdf' },
      confirmed_at: '2026-07-27T09:10:00Z',
      version: 2,
      created_at: '2026-07-25T09:10:00Z',
      updated_at: '2026-07-27T09:10:00Z',
    },
    {
      id: '30000000-0000-4000-8000-000000000002',
      user_id: ids.user,
      kind: 'skill',
      value: { name: 'Design systems', years: 3 },
      scope: { use: 'selected_goals', goal_ids: [ids.goal] },
      status: 'pending_confirmation',
      source: { type: 'file', reference: 'portfolio-2026.pdf' },
      version: 1,
      created_at: '2026-07-29T11:35:00Z',
      updated_at: '2026-07-29T11:35:00Z',
    },
    {
      id: '30000000-0000-4000-8000-000000000003',
      user_id: ids.user,
      kind: 'work_authorization',
      value: { country: 'US', answer: 'Needs manual confirmation' },
      scope: { use: 'manual_only' },
      status: 'expired',
      source: { type: 'user', reference: 'onboarding' },
      valid_until: '2026-06-30T23:59:59Z',
      version: 1,
      created_at: '2026-01-02T08:00:00Z',
      updated_at: '2026-07-01T08:00:00Z',
    },
  ],
  page: { page_size: 20, next_cursor: null, total_estimate: 3 },
};

export const mockMaterials: CursorPage<Material> = {
  items: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      user_id: ids.user,
      kind: 'resume',
      status: 'approved',
      version: 4,
      file_ids: ['50000000-0000-4000-8000-000000000001'],
      fact_citations: [
        {
          fact_id: mockFacts.items[0].id,
          fact_version: 2,
          claim_path: '/experience/0',
          status: 'verified',
        },
        {
          fact_id: mockFacts.items[1].id,
          fact_version: 1,
          claim_path: '/skills/0',
          status: 'pending_confirmation',
        },
      ],
      created_at: '2026-07-26T15:20:00Z',
      updated_at: '2026-07-28T10:05:00Z',
    },
    {
      id: '40000000-0000-4000-8000-000000000002',
      user_id: ids.user,
      job_id: '90000000-0000-4000-8000-000000000001',
      kind: 'resume',
      status: 'review_required',
      version: 2,
      file_ids: ['50000000-0000-4000-8000-000000000002'],
      fact_citations: [
        {
          fact_id: mockFacts.items[0].id,
          fact_version: 2,
          claim_path: '/experience/0',
          status: 'verified',
        },
      ],
      created_at: '2026-07-29T18:20:00Z',
      updated_at: '2026-07-30T08:30:00Z',
    },
  ],
  page: { page_size: 20, next_cursor: null, total_estimate: 2 },
};

export async function loadProfileMock() {
  return Promise.resolve({ goals: mockGoals, facts: mockFacts, materials: mockMaterials });
}
