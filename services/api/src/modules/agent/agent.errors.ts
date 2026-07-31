import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { AgentErrorCode } from './agent.types';

const STATUS_BY_CODE: Record<AgentErrorCode, number> = {
  AUTH_REQUIRED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  FORBIDDEN: 403,
  TOKEN_SCOPE_INSUFFICIENT: 403,
  RESOURCE_NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CREDENTIAL_DATA_FORBIDDEN: 422,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  REPLAY_DETECTED: 409,
  PAIRING_CODE_INVALID: 422,
  INTERNAL_ERROR: 500,
};

const MESSAGE_BY_CODE: Record<AgentErrorCode, string> = {
  AUTH_REQUIRED: 'Agent authentication is required.',
  TOKEN_EXPIRED: 'The agent token has expired.',
  TOKEN_REVOKED: 'The agent authorization has been revoked.',
  FORBIDDEN: 'The requested agent resource is forbidden.',
  TOKEN_SCOPE_INSUFFICIENT: 'The agent token does not grant the required scope.',
  RESOURCE_NOT_FOUND: 'The requested resource was not found.',
  VALIDATION_FAILED: 'The request is invalid.',
  CREDENTIAL_DATA_FORBIDDEN: 'Credential data is not accepted by the cloud agent API.',
  CONFLICT: 'The request conflicts with the current resource state.',
  IDEMPOTENCY_KEY_REUSED: 'The idempotency key was already used for a different request.',
  REPLAY_DETECTED: 'A one-time token or nonce was already consumed.',
  PAIRING_CODE_INVALID: 'The pairing session cannot be claimed.',
  INTERNAL_ERROR: 'The request could not be completed.',
};

export class AgentProtocolError extends HttpException {
  constructor(
    public readonly code: AgentErrorCode,
    options: {
      message?: string;
      retryable?: boolean;
      requestId?: string;
      correlationId?: string;
    } = {},
  ) {
    const requestId = options.requestId ?? randomUUID();
    const correlationId = options.correlationId ?? requestId;
    super(
      {
        error: {
          code,
          message: options.message ?? MESSAGE_BY_CODE[code],
          retryable: options.retryable ?? false,
        },
        request_id: requestId,
        correlation_id: correlationId,
      },
      STATUS_BY_CODE[code],
    );
  }
}
