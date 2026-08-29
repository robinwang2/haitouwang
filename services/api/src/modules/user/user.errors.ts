export type UserErrorCode = 'RESOURCE_NOT_FOUND';

export class UserError extends Error {
  constructor(
    readonly code: UserErrorCode,
    message: string,
    readonly status: 404,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
