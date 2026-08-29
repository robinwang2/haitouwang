import { Injectable } from '@nestjs/common';

import type { ReviewStore } from './review-store.interface';
import type { Review } from './review.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

@Injectable()
export class InMemoryReviewStore implements ReviewStore {
  private readonly reviews = new Map<string, Review>();

  async withTransaction<T>(operation: (store: ReviewStore) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async saveReview(review: Review): Promise<Review> {
    if (this.reviews.has(review.id)) {
      throw new Error(`Review id already exists: ${review.id}`);
    }
    const saved = clone(review);
    this.reviews.set(saved.id, saved);
    return clone(saved);
  }

  async updateReview(userId: string, review: Review): Promise<void> {
    const existing = this.reviews.get(review.id);
    if (!existing || existing.user_id !== userId) return;
    this.reviews.set(review.id, clone(review));
  }

  async getReview(userId: string, reviewId: string): Promise<Review | undefined> {
    const review = this.reviews.get(reviewId);
    if (!review || review.user_id !== userId) return undefined;
    return clone(review);
  }

  async listReviews(userId: string): Promise<Review[]> {
    return [...this.reviews.values()]
      .filter((review) => review.user_id === userId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(clone);
  }
}
