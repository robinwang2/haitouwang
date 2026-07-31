import { Injectable } from '@nestjs/common';

import type { IndexedKnowledgeChunk } from './knowledge.types';

@Injectable()
export class InMemoryKnowledgeIndex {
  private readonly chunks = new Map<string, IndexedKnowledgeChunk>();
  private readonly factVersions = new Map<string, number>();

  public replaceFact(
    userId: string,
    factId: string,
    factVersion: number,
    chunks: readonly IndexedKnowledgeChunk[],
  ): boolean {
    const key = factKey(userId, factId);
    const currentVersion = this.factVersions.get(key);
    if (currentVersion !== undefined && factVersion < currentVersion) return false;

    validateReplacement(userId, factId, factVersion, chunks);
    this.removeChunks(userId, factId);
    chunks.forEach((chunk) => this.chunks.set(chunk.id, cloneChunk(chunk)));
    this.factVersions.set(key, factVersion);
    return true;
  }

  public removeFact(userId: string, factId: string, factVersion?: number): boolean {
    const key = factKey(userId, factId);
    const currentVersion = this.factVersions.get(key);
    if (factVersion !== undefined && currentVersion !== undefined && factVersion < currentVersion) {
      return false;
    }

    this.removeChunks(userId, factId);
    if (factVersion !== undefined) {
      this.factVersions.set(key, Math.max(currentVersion ?? 0, factVersion));
    }
    return true;
  }

  public listForUser(userId: string): IndexedKnowledgeChunk[] {
    return [...this.chunks.values()].filter((chunk) => chunk.user_id === userId).map(cloneChunk);
  }

  public countForFact(userId: string, factId: string): number {
    return [...this.chunks.values()].filter(
      (chunk) => chunk.user_id === userId && chunk.fact_id === factId,
    ).length;
  }

  public getFactVersion(userId: string, factId: string): number | undefined {
    return this.factVersions.get(factKey(userId, factId));
  }

  private removeChunks(userId: string, factId: string): void {
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (chunk.user_id === userId && chunk.fact_id === factId) {
        this.chunks.delete(chunkId);
      }
    }
  }
}

function validateReplacement(
  userId: string,
  factId: string,
  factVersion: number,
  chunks: readonly IndexedKnowledgeChunk[],
): void {
  const ids = new Set<string>();
  for (const chunk of chunks) {
    if (
      chunk.user_id !== userId ||
      chunk.fact_id !== factId ||
      chunk.fact_version !== factVersion
    ) {
      throw new Error('All replacement chunks must belong to the supplied fact version.');
    }
    if (ids.has(chunk.id)) throw new Error(`Duplicate knowledge chunk id: ${chunk.id}`);
    ids.add(chunk.id);
  }
}

function factKey(userId: string, factId: string): string {
  return `${userId}\u0000${factId}`;
}

function cloneChunk(chunk: IndexedKnowledgeChunk): IndexedKnowledgeChunk {
  return {
    ...chunk,
    scope: {
      use: chunk.scope.use,
      ...(chunk.scope.goal_ids ? { goal_ids: [...chunk.scope.goal_ids] } : {}),
    },
    source: { ...chunk.source },
    tags: [...chunk.tags],
    embedding: [...chunk.embedding],
  };
}
