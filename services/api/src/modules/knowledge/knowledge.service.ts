import { Injectable } from '@nestjs/common';

import type { Fact } from '../profile';

import { chunkFact } from './knowledge.chunker';
import { DeterministicEmbeddingProvider } from './knowledge.embedding';
import { InMemoryKnowledgeIndex } from './knowledge.index';
import { clampScore, normalizeText, tokenize } from './knowledge.text';
import {
  KnowledgeInputError,
  type ChunkingOptions,
  type EmbeddingProvider,
  type FactSyncResult,
  type IndexedKnowledgeChunk,
  type KnowledgeRetrievalQuery,
  type KnowledgeRetrievalResult,
} from './knowledge.types';

interface ScoredChunk {
  chunk: IndexedKnowledgeChunk;
  keyword: number;
  vector: number;
  tag: number;
  hybrid: number;
  rerank: number;
  matchedTerms: string[];
}

@Injectable()
export class KnowledgeService {
  public constructor(
    private readonly index = new InMemoryKnowledgeIndex(),
    private readonly embeddings: EmbeddingProvider = new DeterministicEmbeddingProvider(),
    private readonly chunking: ChunkingOptions = {},
  ) {}

  public async syncFact(fact: Fact): Promise<FactSyncResult> {
    validateFactIdentity(fact);
    const chunks = chunkFact(fact, this.chunking);
    if (chunks.length === 0) {
      const removed = this.index.removeFact(fact.user_id, fact.id, fact.version);
      return {
        fact_id: fact.id,
        fact_version: fact.version,
        indexed_chunks: 0,
        operation: removed ? 'removed' : 'ignored_stale',
      };
    }

    const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.content));
    if (vectors.length !== chunks.length) {
      throw new KnowledgeInputError(
        `Embedding provider returned ${vectors.length} vectors for ${chunks.length} chunks.`,
      );
    }
    const indexed = chunks.map((chunk, index) => ({
      ...chunk,
      embedding: validateEmbedding(vectors[index], this.embeddings.dimensions, index),
    }));
    const replaced = this.index.replaceFact(fact.user_id, fact.id, fact.version, indexed);
    return {
      fact_id: fact.id,
      fact_version: fact.version,
      indexed_chunks: replaced ? indexed.length : this.index.countForFact(fact.user_id, fact.id),
      operation: replaced ? 'indexed' : 'ignored_stale',
    };
  }

  public async syncFacts(userId: string, facts: readonly Fact[]): Promise<FactSyncResult[]> {
    if (userId.trim().length === 0) throw new KnowledgeInputError('userId is required.');
    const seen = new Set<string>();
    for (const fact of facts) {
      if (fact.user_id !== userId) {
        throw new KnowledgeInputError('All synchronized facts must belong to userId.');
      }
      if (seen.has(fact.id)) throw new KnowledgeInputError(`Duplicate fact id: ${fact.id}`);
      seen.add(fact.id);
    }

    const results: FactSyncResult[] = [];
    for (const fact of facts) results.push(await this.syncFact(fact));

    const suppliedIds = new Set(facts.map((fact) => fact.id));
    const indexedIds = new Set(this.index.listForUser(userId).map((chunk) => chunk.fact_id));
    for (const factId of indexedIds) {
      if (!suppliedIds.has(factId)) this.index.removeFact(userId, factId);
    }
    return results;
  }

  public deleteFact(userId: string, factId: string, factVersion?: number): boolean {
    if (userId.trim().length === 0 || factId.trim().length === 0) {
      throw new KnowledgeInputError('userId and factId are required.');
    }
    return this.index.removeFact(userId, factId, factVersion);
  }

  public async retrieve(query: KnowledgeRetrievalQuery): Promise<KnowledgeRetrievalResult[]> {
    const evaluatedAt = validateQuery(query);
    const normalizedQuery = normalizeText(query.text);
    const queryTerms = tokenize(query.text);
    const requestedTags = new Set((query.tags ?? []).map(normalizeText).filter(Boolean));
    const queryEmbedding =
      normalizedQuery.length === 0
        ? Array.from({ length: this.embeddings.dimensions }, () => 0)
        : validateEmbedding(
            (await this.embeddings.embed([query.text]))[0],
            this.embeddings.dimensions,
            0,
          );

    const scored = this.index
      .listForUser(query.user_id)
      .filter((chunk) => isRetrievable(chunk, query.goal_id, evaluatedAt))
      .filter((chunk) => !query.kinds || query.kinds.includes(chunk.fact_kind))
      .map((chunk) => scoreChunk(chunk, normalizedQuery, queryTerms, requestedTags, queryEmbedding))
      .filter((candidate) => {
        if (normalizedQuery.length > 0) {
          return candidate.keyword > 0 || candidate.vector > 0 || candidate.tag > 0;
        }
        return requestedTags.size === 0 || candidate.tag > 0;
      })
      .sort(compareScoredChunks);

    return scored.slice(0, query.limit ?? 10).map(toResult);
  }
}

export { KnowledgeService as FactKnowledgeService };

export function isRetrievable(
  chunk: IndexedKnowledgeChunk,
  goalId: string | undefined,
  evaluatedAt: number,
): boolean {
  if (chunk.fact_status !== 'active' || chunk.confirmed_at.length === 0) return false;
  if (chunk.scope.use === 'manual_only' || chunk.scope.use === 'prohibited') return false;
  if (
    chunk.scope.use === 'selected_goals' &&
    (!goalId || !chunk.scope.goal_ids?.includes(goalId))
  ) {
    return false;
  }

  const validFrom = parseOptionalDate(chunk.valid_from);
  const validUntil = parseOptionalDate(chunk.valid_until);
  if (validFrom === null || validUntil === null) return false;
  return (
    (validFrom === undefined || validFrom <= evaluatedAt) &&
    (validUntil === undefined || validUntil > evaluatedAt)
  );
}

function scoreChunk(
  chunk: IndexedKnowledgeChunk,
  normalizedQuery: string,
  queryTerms: readonly string[],
  requestedTags: ReadonlySet<string>,
  queryEmbedding: readonly number[],
): ScoredChunk {
  const contentTerms = new Set(tokenize(chunk.content));
  const matchedTerms = queryTerms.filter((term) => contentTerms.has(term));
  const keyword =
    queryTerms.length === 0
      ? 0
      : clampScore(
          matchedTerms.length / queryTerms.length +
            (normalizeText(chunk.content).includes(normalizedQuery) ? 0.2 : 0),
        );
  const vector = cosineSimilarity(queryEmbedding, chunk.embedding);
  const normalizedTags = new Set(chunk.tags.map(normalizeText));
  const matchedTags = [...requestedTags].filter((tag) => normalizedTags.has(tag)).length;
  const tag = requestedTags.size === 0 ? 0 : matchedTags / requestedTags.size;

  const hasText = normalizedQuery.length > 0;
  const hasTags = requestedTags.size > 0;
  const hybrid =
    hasText && hasTags
      ? 0.45 * keyword + 0.35 * vector + 0.2 * tag
      : hasText
        ? 0.56 * keyword + 0.44 * vector
        : tag;
  const coverage = queryTerms.length === 0 ? 0 : matchedTerms.length / queryTerms.length;
  const exactPhrase =
    normalizedQuery.length > 0 && normalizeText(chunk.content).includes(normalizedQuery) ? 1 : 0;
  const rerank = clampScore(0.72 * hybrid + 0.18 * coverage + 0.1 * exactPhrase);

  return { chunk, keyword, vector, tag, hybrid, rerank, matchedTerms };
}

function toResult(candidate: ScoredChunk): KnowledgeRetrievalResult {
  const { chunk } = candidate;
  const source = { ...chunk.source };
  return {
    chunk_id: chunk.id,
    fact_id: chunk.fact_id,
    fact_version: chunk.fact_version,
    fact_kind: chunk.fact_kind,
    source,
    claim_path: chunk.claim_path,
    content: chunk.content,
    citation: {
      fact_id: chunk.fact_id,
      fact_version: chunk.fact_version,
      source: { ...source },
      claim_path: chunk.claim_path,
    },
    score: candidate.rerank,
    scores: {
      keyword: candidate.keyword,
      vector: candidate.vector,
      tag: candidate.tag,
      hybrid: candidate.hybrid,
      rerank: candidate.rerank,
    },
    matched_terms: [...candidate.matchedTerms],
  };
}

function compareScoredChunks(left: ScoredChunk, right: ScoredChunk): number {
  return (
    right.rerank - left.rerank ||
    Date.parse(right.chunk.updated_at) - Date.parse(left.chunk.updated_at) ||
    left.chunk.id.localeCompare(right.chunk.id)
  );
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! * left[index]!;
    rightMagnitude += right[index]! * right[index]!;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return clampScore(dot / Math.sqrt(leftMagnitude * rightMagnitude));
}

function validateEmbedding(
  embedding: readonly number[] | undefined,
  dimensions: number,
  index: number,
): number[] {
  if (
    !embedding ||
    embedding.length !== dimensions ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new KnowledgeInputError(
      `Embedding ${index} must contain exactly ${dimensions} finite values.`,
    );
  }
  return [...embedding];
}

function validateQuery(query: KnowledgeRetrievalQuery): number {
  if (!query || typeof query.user_id !== 'string' || query.user_id.trim().length === 0) {
    throw new KnowledgeInputError('query.user_id is required.');
  }
  if (typeof query.text !== 'string') throw new KnowledgeInputError('query.text must be a string.');
  if (query.text.trim().length === 0 && (query.tags?.length ?? 0) === 0 && !query.kinds?.length) {
    throw new KnowledgeInputError('A query must include text, tags, or kinds.');
  }
  const evaluatedAt = Date.parse(query.evaluated_at);
  if (!Number.isFinite(evaluatedAt)) {
    throw new KnowledgeInputError('query.evaluated_at must be an ISO timestamp.');
  }
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
  ) {
    throw new KnowledgeInputError('query.limit must be an integer between 1 and 100.');
  }
  return evaluatedAt;
}

function validateFactIdentity(fact: Fact): void {
  if (
    !fact ||
    typeof fact.id !== 'string' ||
    fact.id.trim().length === 0 ||
    typeof fact.user_id !== 'string' ||
    fact.user_id.trim().length === 0
  ) {
    throw new KnowledgeInputError('A fact with id and user_id is required.');
  }
  if (!Number.isInteger(fact.version) || fact.version < 1) {
    throw new KnowledgeInputError('fact.version must be a positive integer.');
  }
}

function parseOptionalDate(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
