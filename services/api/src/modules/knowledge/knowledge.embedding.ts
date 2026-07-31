import { Injectable } from '@nestjs/common';

import { tokenize } from './knowledge.text';
import type { EmbeddingProvider } from './knowledge.types';

/**
 * A local, deterministic feature-hashing embedding used for tests and as a
 * provider-independent fallback. Production providers can implement the same
 * interface without changing retrieval or authorization behavior.
 */
@Injectable()
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions: number;

  public constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 32 || dimensions > 4096) {
      throw new RangeError('Embedding dimensions must be an integer between 32 and 4096.');
    }
    this.dimensions = dimensions;
  }

  public embed(texts: readonly string[]): readonly (readonly number[])[] {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    for (const term of tokenize(text)) {
      const hash = fnv1a(term);
      const index = hash % this.dimensions;
      const sign = (hash & 0x80000000) === 0 ? 1 : -1;
      vector[index] += sign;
    }

    const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
