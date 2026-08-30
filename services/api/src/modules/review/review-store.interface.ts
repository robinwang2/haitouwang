import type { Review } from './review.types';

export const REVIEW_STORE = Symbol('REVIEW_STORE');

/**
 * Persistence boundary for the Review aggregate. Every operation is tenant-scoped by
 * user_id.
 */
export interface ReviewStore {
  withTransaction<T>(operation: (store: ReviewStore) => Promise<T>): Promise<T>;

  saveReview(review: Review): Promise<Review>;
  updateReview(userId: string, review: Review): Promise<void>;
  getReview(userId: string, reviewId: string): Promise<Review | undefined>;
  listReviews(userId: string): Promise<Review[]>;
}
