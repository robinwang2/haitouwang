import { Module } from '@nestjs/common';

import { DeterministicEmbeddingProvider } from './knowledge.embedding';
import { InMemoryKnowledgeIndex } from './knowledge.index';
import { KnowledgeService } from './knowledge.service';

@Module({
  providers: [
    DeterministicEmbeddingProvider,
    InMemoryKnowledgeIndex,
    {
      provide: KnowledgeService,
      useFactory: (index: InMemoryKnowledgeIndex, embeddings: DeterministicEmbeddingProvider) =>
        new KnowledgeService(index, embeddings),
      inject: [InMemoryKnowledgeIndex, DeterministicEmbeddingProvider],
    },
  ],
  exports: [KnowledgeService, InMemoryKnowledgeIndex],
})
export class KnowledgeModule {}
