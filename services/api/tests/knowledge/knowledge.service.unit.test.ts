import { describe, expect, it } from 'vitest';

import {
  DeterministicEmbeddingProvider,
  InMemoryKnowledgeIndex,
  KnowledgeInputError,
  KnowledgeService,
  chunkFact,
  type EmbeddingProvider,
} from '../../src/modules/knowledge';
import type { Fact } from '../../src/modules/profile';

const NOW = '2026-07-30T12:00:00.000Z';
const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const GOAL_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_GOAL_ID = '20000000-0000-4000-8000-000000000002';

function fact(id: number, value: Fact['value'], overrides: Partial<Fact> = {}): Fact {
  return {
    id: `40000000-0000-4000-8000-${id.toString().padStart(12, '0')}`,
    user_id: USER_ID,
    kind: 'experience',
    value,
    scope: { use: 'all_goals' },
    status: 'active',
    source: { type: 'file', reference: `resume:${id}` },
    confirmed_at: '2026-07-29T12:00:00.000Z',
    version: 1,
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

function query(overrides: Partial<Parameters<KnowledgeService['retrieve']>[0]> = {}) {
  return {
    user_id: USER_ID,
    goal_id: GOAL_ID,
    text: 'TypeScript distributed systems',
    evaluated_at: NOW,
    limit: 10,
    ...overrides,
  };
}

describe('fact chunking', () => {
  it('creates bounded chunks with stable fact provenance', () => {
    const input = fact(1, { summary: 'TypeScript '.repeat(40) });
    const chunks = chunkFact(input, { max_chunk_chars: 96, overlap_chars: 12 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 96)).toBe(true);
    expect(
      chunks.every(
        (chunk) =>
          chunk.fact_id === input.id &&
          chunk.fact_version === 1 &&
          chunk.source.reference === 'resume:1' &&
          chunk.claim_path === 'value.summary',
      ),
    ).toBe(true);
  });
});

describe('KnowledgeService hybrid retrieval', () => {
  it('combines keyword, vector and tag signals then reranks exact coverage first', async () => {
    const service = new KnowledgeService();
    await service.syncFacts(USER_ID, [
      fact(1, { summary: 'Built TypeScript distributed systems and reliable APIs.' }),
      fact(2, { summary: 'Built TypeScript user interfaces.' }),
      fact(3, { summary: 'Managed sales operations.' }, { kind: 'preference' }),
    ]);

    const results = await service.retrieve(query({ tags: ['summary'] }));

    expect(results.slice(0, 2).map((result) => result.fact_id)).toEqual([
      fact(1, {}).id,
      fact(2, {}).id,
    ]);
    expect(results[2]).toMatchObject({
      fact_id: fact(3, {}).id,
      scores: { keyword: 0, tag: 1 },
    });
    expect(results[0]!.scores.keyword).toBeGreaterThan(results[1]!.scores.keyword);
    expect(results[0]!.scores.tag).toBe(1);
    expect(results[0]!.scores.rerank).toBe(results[0]!.score);
  });

  it('returns the fact version, source and claim path on every result', async () => {
    const service = new KnowledgeService();
    await service.syncFact(fact(1, { summary: 'TypeScript distributed systems' }, { version: 7 }));

    const [result] = await service.retrieve(query());

    expect(result).toMatchObject({
      fact_id: fact(1, {}).id,
      fact_version: 7,
      source: { type: 'file', reference: 'resume:1' },
      claim_path: 'value.summary',
      citation: {
        fact_id: fact(1, {}).id,
        fact_version: 7,
        source: { type: 'file', reference: 'resume:1' },
        claim_path: 'value.summary',
      },
    });
  });

  it('has zero recall for cross-tenant, prohibited, expired and out-of-scope facts', async () => {
    const service = new KnowledgeService();
    await Promise.all([
      service.syncFact(fact(1, { summary: 'TypeScript distributed systems allowed' })),
      service.syncFact(
        fact(
          2,
          { summary: 'TypeScript distributed systems other tenant' },
          { user_id: OTHER_USER_ID },
        ),
      ),
      service.syncFact(
        fact(
          3,
          { summary: 'TypeScript distributed systems prohibited status' },
          { status: 'prohibited' },
        ),
      ),
      service.syncFact(
        fact(
          4,
          { summary: 'TypeScript distributed systems prohibited scope' },
          { scope: { use: 'prohibited' } },
        ),
      ),
      service.syncFact(
        fact(
          5,
          { summary: 'TypeScript distributed systems manual only' },
          { scope: { use: 'manual_only' } },
        ),
      ),
      service.syncFact(
        fact(
          6,
          { summary: 'TypeScript distributed systems explicitly expired' },
          { status: 'expired' },
        ),
      ),
      service.syncFact(
        fact(7, { summary: 'TypeScript distributed systems past validity' }, { valid_until: NOW }),
      ),
      service.syncFact(
        fact(
          8,
          { summary: 'TypeScript distributed systems future validity' },
          { valid_from: '2026-08-01T00:00:00.000Z' },
        ),
      ),
      service.syncFact(
        fact(
          9,
          { summary: 'TypeScript distributed systems wrong goal' },
          { scope: { use: 'selected_goals', goal_ids: [OTHER_GOAL_ID] } },
        ),
      ),
      service.syncFact(
        fact(
          10,
          { summary: 'TypeScript distributed systems right goal' },
          { scope: { use: 'selected_goals', goal_ids: [GOAL_ID] } },
        ),
      ),
      service.syncFact(
        fact(
          11,
          { summary: 'TypeScript distributed systems not confirmed' },
          { confirmed_at: undefined },
        ),
      ),
    ]);

    const results = await service.retrieve(query());

    expect(results.map((result) => result.fact_id).sort()).toEqual(
      [fact(10, {}).id, fact(1, {}).id].sort(),
    );
    expect(results.every((result) => result.source.reference !== 'resume:2')).toBe(true);
  });

  it('synchronizes updates and deletion without allowing a stale write to resurrect data', async () => {
    const index = new InMemoryKnowledgeIndex();
    const service = new KnowledgeService(index);
    await service.syncFact(fact(1, { summary: 'Legacy PHP systems' }));
    await service.syncFact(fact(1, { summary: 'Modern TypeScript systems' }, { version: 2 }));

    expect(await service.retrieve(query({ text: 'Legacy PHP' }))).toEqual([]);
    expect((await service.retrieve(query({ text: 'Modern TypeScript' })))[0]).toMatchObject({
      fact_version: 2,
    });

    await service.syncFact(
      fact(1, { summary: '' }, { version: 3, status: 'deleted', confirmed_at: undefined }),
    );
    const stale = await service.syncFact(
      fact(1, { summary: 'Legacy PHP systems' }, { version: 2 }),
    );

    expect(stale.operation).toBe('ignored_stale');
    expect(index.countForFact(USER_ID, fact(1, {}).id)).toBe(0);
    expect(await service.retrieve(query({ text: 'systems' }))).toEqual([]);
  });

  it('removes facts omitted from an authoritative full synchronization', async () => {
    const index = new InMemoryKnowledgeIndex();
    const service = new KnowledgeService(index);
    await service.syncFacts(USER_ID, [
      fact(1, { summary: 'TypeScript systems' }),
      fact(2, { summary: 'PostgreSQL systems' }),
    ]);

    await service.syncFacts(USER_ID, [fact(1, { summary: 'TypeScript systems' })]);

    expect(index.countForFact(USER_ID, fact(2, {}).id)).toBe(0);
  });

  it('fails closed when validity metadata or provider embeddings are invalid', async () => {
    const service = new KnowledgeService();
    await service.syncFact(
      fact(1, { summary: 'TypeScript systems' }, { valid_until: 'not-a-date' }),
    );
    expect(await service.retrieve(query({ text: 'TypeScript' }))).toEqual([]);

    const invalidProvider: EmbeddingProvider = {
      dimensions: 32,
      embed: () => [[Number.NaN]],
    };
    const invalidService = new KnowledgeService(new InMemoryKnowledgeIndex(), invalidProvider);
    await expect(invalidService.syncFact(fact(2, { summary: 'TypeScript' }))).rejects.toThrow(
      KnowledgeInputError,
    );
  });

  it('supports Chinese keyword retrieval and validates unsafe query limits', async () => {
    const service = new KnowledgeService(
      new InMemoryKnowledgeIndex(),
      new DeterministicEmbeddingProvider(64),
    );
    await service.syncFact(fact(1, { summary: '负责分布式系统与可观测性平台' }));

    expect((await service.retrieve(query({ text: '分布式系统' })))[0]?.fact_id).toBe(
      fact(1, {}).id,
    );
    await expect(service.retrieve(query({ limit: 101 }))).rejects.toThrow(KnowledgeInputError);
  });

  it('uses tags as a candidate signal without returning zero-score tag misses', async () => {
    const service = new KnowledgeService();
    await service.syncFacts(USER_ID, [
      fact(1, { summary: 'Backend engineering' }),
      fact(2, { title: 'Platform Engineer' }),
    ]);

    const results = await service.retrieve(
      query({ text: '', tags: ['title'], goal_id: undefined }),
    );

    expect(results.map((result) => result.fact_id)).toEqual([fact(2, {}).id]);
  });
});
