import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KnowledgeService } from '../../src/modules/knowledge';
import type { Fact } from '../../src/modules/profile';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const GOAL_ID = '20000000-0000-4000-8000-000000000001';
const NOW = '2026-07-30T12:00:00.000Z';

interface GoldenQuery {
  query: string;
  relevant_fact_ids: string[];
}

const factContents: Record<string, string> = {
  'fact-backend': 'Built TypeScript services for large distributed systems.',
  'fact-database': 'Optimized PostgreSQL queries and database indexes.',
  'fact-cloud': 'Operated Kubernetes clusters and AWS infrastructure.',
  'fact-leadership': 'Mentored engineers and led architecture reviews.',
  'fact-observability': '负责可观测性平台、指标采集与告警系统。',
  'fact-design': 'Designed accessible web user interfaces.',
  'fact-sales': 'Managed enterprise sales and customer accounts.',
  'fact-finance': 'Prepared financial reports and budget forecasts.',
  'fact-writing': 'Published technical documentation and tutorials.',
  'fact-support': 'Resolved customer support tickets.',
  'fact-marketing': 'Planned brand campaigns and social media calendars.',
  'fact-operations': 'Coordinated vendor procurement and office operations.',
  'fact-research': 'Conducted qualitative interviews and market research.',
  'fact-recruiting': 'Scheduled candidate interviews and recruiting events.',
  'fact-logistics': 'Tracked inventory shipments and warehouse capacity.',
  'fact-legal': 'Reviewed commercial contracts and policy documents.',
  'fact-healthcare': 'Maintained clinical scheduling and patient records.',
  'fact-education': 'Developed classroom lesson plans and learning assessments.',
  'fact-retail': 'Managed store merchandising and point-of-sale workflows.',
  'fact-media': 'Edited video productions and managed content archives.',
};

function goldenSet(): GoldenQuery[] {
  const path = fileURLToPath(new URL('./fixtures/retrieval-golden-set.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenQuery[];
}

function fact(id: string, summary: string): Fact {
  return {
    id,
    user_id: USER_ID,
    kind: 'experience',
    value: { summary },
    scope: { use: 'all_goals' },
    status: 'active',
    source: { type: 'user', reference: 'retrieval-golden-set' },
    confirmed_at: NOW,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe('knowledge retrieval golden set', () => {
  it('keeps Recall@10 at or above 0.80', async () => {
    const service = new KnowledgeService();
    await service.syncFacts(
      USER_ID,
      Object.entries(factContents).map(([id, content]) => fact(id, content)),
    );

    let relevant = 0;
    let recalled = 0;
    for (const sample of goldenSet()) {
      const results = await service.retrieve({
        user_id: USER_ID,
        goal_id: GOAL_ID,
        text: sample.query,
        evaluated_at: NOW,
        limit: 10,
      });
      const resultIds = new Set(results.map((result) => result.fact_id));
      relevant += sample.relevant_fact_ids.length;
      recalled += sample.relevant_fact_ids.filter((id) => resultIds.has(id)).length;
    }

    const recallAt10 = recalled / relevant;
    expect({ recalled, relevant, recallAt10 }).toEqual({
      recalled: 5,
      relevant: 5,
      recallAt10: 1,
    });
    expect(recallAt10).toBeGreaterThanOrEqual(0.8);
  });
});
