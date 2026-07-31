export type ProfileErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'STATE_TRANSITION_INVALID'
  | 'IDEMPOTENCY_KEY_REUSED';

export class ProfileError extends Error {
  constructor(
    readonly code: ProfileErrorCode,
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}
