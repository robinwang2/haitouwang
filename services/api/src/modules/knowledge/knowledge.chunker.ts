import type { Fact } from '../profile';

import type { ChunkingOptions, KnowledgeChunk } from './knowledge.types';

const DEFAULT_MAX_CHUNK_CHARS = 512;
const DEFAULT_OVERLAP_CHARS = 64;

export function chunkFact(fact: Fact, options: ChunkingOptions = {}): KnowledgeChunk[] {
  const maxChunkChars = options.max_chunk_chars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlapChars = options.overlap_chars ?? DEFAULT_OVERLAP_CHARS;
  validateOptions(maxChunkChars, overlapChars);

  if (!isIndexableFact(fact)) return [];

  const chunks: KnowledgeChunk[] = [];
  const entries = Object.entries(fact.value).sort(([left], [right]) => left.localeCompare(right));

  for (const [field, rawValue] of entries) {
    const value = rawValue === null ? 'null' : String(rawValue).trim();
    if (value.length === 0) continue;

    const claimPath = `value.${field}`;
    const fullPrefix = `${fact.kind} ${field}: `;
    const prefix =
      fullPrefix.length < maxChunkChars
        ? fullPrefix
        : `${fullPrefix.slice(0, maxChunkChars - 2)}: `;
    const availableChars = Math.max(1, maxChunkChars - prefix.length);
    const sliceOverlap = Math.min(
      overlapChars,
      16,
      Math.max(0, Math.floor((availableChars - 1) / 2)),
    );
    const slices = splitText(value, availableChars, sliceOverlap);

    slices.forEach((slice, index) => {
      chunks.push({
        id: `${fact.id}:v${fact.version}:${field}:${index}`,
        user_id: fact.user_id,
        fact_id: fact.id,
        fact_version: fact.version,
        fact_kind: fact.kind,
        fact_status: 'active',
        confirmed_at: fact.confirmed_at!,
        scope: cloneScope(fact.scope),
        valid_from: fact.valid_from,
        valid_until: fact.valid_until,
        source: { ...fact.source },
        claim_path: claimPath,
        content: `${prefix}${slice}`,
        tags: [...new Set([fact.kind, field, claimPath])],
        updated_at: fact.updated_at,
      });
    });
  }

  return chunks;
}

export function isIndexableFact(fact: Fact): fact is Fact & {
  status: 'active';
  confirmed_at: string;
} {
  return (
    fact.status === 'active' &&
    typeof fact.confirmed_at === 'string' &&
    fact.confirmed_at.length > 0 &&
    fact.scope.use !== 'manual_only' &&
    fact.scope.use !== 'prohibited'
  );
}

function splitText(value: string, maxChars: number, overlapChars: number): string[] {
  if (value.length <= maxChars) return [value];

  const slices: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + maxChars);
    if (end < value.length) {
      const whitespace = value.lastIndexOf(' ', end);
      if (whitespace > start + Math.floor(maxChars / 2)) end = whitespace;
    }

    const slice = value.slice(start, end).trim();
    if (slice.length > 0) slices.push(slice);
    if (end >= value.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return slices;
}

function validateOptions(maxChunkChars: number, overlapChars: number): void {
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < 64 || maxChunkChars > 10_000) {
    throw new RangeError('max_chunk_chars must be an integer between 64 and 10000.');
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChunkChars / 2) {
    throw new RangeError('overlap_chars must be a non-negative integer below half the chunk size.');
  }
}

function cloneScope(scope: Fact['scope']): Fact['scope'] {
  return {
    use: scope.use,
    ...(scope.goal_ids ? { goal_ids: [...scope.goal_ids] } : {}),
  };
}
