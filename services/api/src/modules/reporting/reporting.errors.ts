export type ReportingErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'STATE_TRANSITION_INVALID'
  | 'IDEMPOTENCY_KEY_REUSED';

export class ReportingError extends Error {
  public constructor(
    public readonly code: ReportingErrorCode,
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ReportingError';
  }
}
