export type ApplicationErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'STATE_TRANSITION_INVALID'
  | 'PRECONDITION_REQUIRED'
  | 'EVIDENCE_REQUIRED'
  | 'MANUAL_INTERVENTION_REQUIRED';

export class ApplicationError extends Error {
  public constructor(
    public readonly code: ApplicationErrorCode,
    message: string,
    public readonly status: 400 | 404 | 409 | 412 | 422,
    public readonly manual_reason?: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
