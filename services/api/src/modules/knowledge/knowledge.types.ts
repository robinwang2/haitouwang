import type { FactKind, FactScope, SourceRef } from '../profile';

export interface FactCitation {
  fact_id: string;
  fact_version: number;
  source: SourceRef;
  claim_path: string;
}

export interface KnowledgeChunk {
  id: string;
  user_id: string;
  fact_id: string;
  fact_version: number;
  fact_kind: FactKind;
  fact_status: 'active';
  confirmed_at: string;
  scope: FactScope;
  valid_from?: string;
  valid_until?: string;
  source: SourceRef;
  claim_path: string;
  content: string;
  tags: string[];
  updated_at: string;
}

export interface IndexedKnowledgeChunk extends KnowledgeChunk {
  embedding: number[];
}

export interface ChunkingOptions {
  max_chunk_chars?: number;
  overlap_chars?: number;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> | readonly (readonly number[])[];
}

export interface KnowledgeRetrievalQuery {
  user_id: string;
  goal_id?: string;
  text: string;
  evaluated_at: string;
  limit?: number;
  kinds?: FactKind[];
  tags?: string[];
}

export interface RetrievalScores {
  keyword: number;
  vector: number;
  tag: number;
  hybrid: number;
  rerank: number;
}

export interface KnowledgeRetrievalResult {
  chunk_id: string;
  fact_id: string;
  fact_version: number;
  fact_kind: FactKind;
  source: SourceRef;
  claim_path: string;
  content: string;
  citation: FactCitation;
  score: number;
  scores: RetrievalScores;
  matched_terms: string[];
}

export interface FactSyncResult {
  fact_id: string;
  fact_version: number;
  indexed_chunks: number;
  operation: 'indexed' | 'removed' | 'ignored_stale';
}

export class KnowledgeInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'KnowledgeInputError';
  }
}
