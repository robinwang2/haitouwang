import { Module } from '@nestjs/common';

import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { REVIEW_STORE } from './review-store.interface';
import type { ReviewStore } from './review-store.interface';
import { PostgresReviewStore } from './review.postgres-store';
import { ReviewService } from './review.service';

function createReviewStore(): ReviewStore {
  return createLazyPostgresStore<ReviewStore>(
    'ReviewModule',
    {
      withTransaction: true,
      saveReview: true,
      updateReview: true,
      getReview: true,
      listReviews: true,
    },
    (pool) => new PostgresReviewStore(pool),
  );
}

@Module({
  providers: [{ provide: REVIEW_STORE, useFactory: createReviewStore }, ReviewService],
  exports: [ReviewService, REVIEW_STORE],
})
export class ReviewModule {}
