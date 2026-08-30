import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Shape shared by domain error classes (e.g. ProfileError): a stable contract error
 * code, a human message, and the HTTP status the module already decided on.
 */
export interface DomainError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

/** Builds a contract-shaped ErrorEnvelope HttpException with a fresh request_id. */
export function httpError(
  status: number,
  code: string,
  message: string,
  correlationId?: string,
): HttpException {
  const requestId = randomUUID();
  return new HttpException(
    {
      error: { code, message, retryable: status >= 500 },
      request_id: requestId,
      correlation_id: correlationId ?? requestId,
    },
    status,
  );
}

/** Maps a domain error onto the contract ErrorEnvelope using its own status/code. */
export function toHttpException(error: DomainError, correlationId?: string): HttpException {
  return httpError(error.status, error.code, error.message, correlationId);
}
