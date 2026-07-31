export type MaterialsErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'STATE_TRANSITION_INVALID'
  | 'FACT_POLICY_VIOLATION'
  | 'MATERIAL_NOT_PUBLISHABLE';

export class MaterialsError extends Error {
  public constructor(
    public readonly code: MaterialsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MaterialsError';
  }
}
