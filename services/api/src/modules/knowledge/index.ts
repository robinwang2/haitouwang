export { chunkFact, isIndexableFact } from './knowledge.chunker';
export { DeterministicEmbeddingProvider } from './knowledge.embedding';
export { InMemoryKnowledgeIndex } from './knowledge.index';
export { KnowledgeModule } from './knowledge.module';
export { FactKnowledgeService, KnowledgeService, isRetrievable } from './knowledge.service';
export {
  KnowledgeInputError,
  type ChunkingOptions,
  type EmbeddingProvider,
  type FactCitation,
  type FactSyncResult,
  type IndexedKnowledgeChunk,
  type KnowledgeChunk,
  type KnowledgeRetrievalQuery,
  type KnowledgeRetrievalResult,
  type RetrievalScores,
} from './knowledge.types';
