export type MaterialsErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'STATE_TRANSITION_INVALID'
  | 'FACT_POLICY_VIOLATION'
  | 'MATERIAL_NOT_PUBLISHABLE'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_NOT_APPROVED'
  | 'REVIEW_HAS_OPEN_MUST_FIX'
  | 'REVIEW_STALE'
  | 'TRANSACTION_FAILED';

export class MaterialsError extends Error {
  public constructor(
    public readonly code: MaterialsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MaterialsError';
  }
}
