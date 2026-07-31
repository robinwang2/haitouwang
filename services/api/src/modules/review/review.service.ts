import { Injectable } from '@nestjs/common';

import { runReview, runReviewCycle } from './review.engine';
import type {
  AutomaticRevisionAgent,
  ReviewCycleOutcome,
  ReviewerAgent,
  ReviewOutcome,
  ReviewRequest,
} from './review.types';

@Injectable()
export class ReviewService {
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
}
