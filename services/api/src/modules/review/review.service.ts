import { Inject, Injectable, Optional } from '@nestjs/common';

import { MaterialsError } from '../materials/materials.errors';
import { runReview, runReviewCycle } from './review.engine';
import { REVIEW_STORE } from './review-store.interface';
import type { ReviewStore } from './review-store.interface';
import type {
  AutomaticRevisionAgent,
  Review,
  ReviewCycleOutcome,
  ReviewerAgent,
  ReviewOutcome,
  ReviewRequest,
} from './review.types';

type Clock = () => string;

@Injectable()
export class ReviewService {
  public constructor(
    @Inject(REVIEW_STORE)
    private readonly store: ReviewStore,
    @Optional()
    private readonly clock: Clock = () => new Date().toISOString(),
  ) {}

  public run(request: ReviewRequest, reviewers?: readonly ReviewerAgent[]): Promise<ReviewOutcome> {
    return runReview(request, reviewers);
  }

  public runAutomaticCycle(
    request: Omit<ReviewRequest, 'round' | 'review_id'>,
    revisionAgent: AutomaticRevisionAgent,
    reviewers?: readonly ReviewerAgent[],
  ): Promise<ReviewCycleOutcome> {
    return runReviewCycle(request, revisionAgent, reviewers);
  }

  public async save(review: Review): Promise<Review> {
    if (!review.id.trim()) {
      throw new MaterialsError('VALIDATION_FAILED', 'Review id is required.');
    }
    try {
      return clone(await this.store.saveReview(clone(review)));
    } catch (error) {
      if (isDuplicate(error)) {
        throw new MaterialsError('CONFLICT', 'Review id already exists.');
      }
      throw error;
    }
  }

  public async get(userId: string, reviewId: string): Promise<Review> {
    const review = await this.store.getReview(userId, reviewId);
    if (!review) throw new MaterialsError('RESOURCE_NOT_FOUND', 'Review not found.');
    return clone(review);
  }

  public async find(userId: string, reviewId: string): Promise<Review | undefined> {
    const review = await this.store.getReview(userId, reviewId);
    return review ? clone(review) : undefined;
  }

  public async list(userId: string): Promise<Review[]> {
    return (await this.store.listReviews(userId)).map(clone);
  }

  public async resolveFinding(
    userId: string,
    reviewId: string,
    findingId: string,
  ): Promise<Review> {
    return this.store.withTransaction(async (store) => {
      const review = await store.getReview(userId, reviewId);
      if (!review) throw new MaterialsError('RESOURCE_NOT_FOUND', 'Review not found.');
      const finding = review.findings.find((candidate) => candidate.id === findingId);
      if (!finding) throw new MaterialsError('RESOURCE_NOT_FOUND', 'Review finding not found.');
      if (finding.status !== 'open') return clone(review);
      finding.status = 'resolved';
      review.version += 1;
      review.updated_at = this.clock();
      if (review.findings.every((candidate) => candidate.status !== 'open')) {
        review.status = 'approved';
        review.recommendation = 'approve';
      }
      await store.updateReview(userId, clone(review));
      return clone(review);
    });
  }
}

function isDuplicate(error: unknown): boolean {
  return (
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: string }).code === '23505') ||
    String(error).includes('already exists')
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
