export type ReviewErrorCode =
  'VALIDATION_FAILED' | 'REVIEW_CONFIGURATION_NOT_ISOLATED' | 'STATE_TRANSITION_INVALID';

export class ReviewError extends Error {
  public constructor(
    public readonly code: ReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}
