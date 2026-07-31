import { AGENT_SCOPES } from './agent.types';
import { AgentProtocolError } from './agent.errors';

import type {
  AgentCapability,
  AgentCommandPayload,
  AgentCommandType,
  AgentScope,
  AgentTokenRequest,
  ClaimCommandRequest,
  ClaimPairingSessionRequest,
  CommandReceiptRequest,
  ConfirmPairingSessionRequest,
  CreatePairingSessionRequest,
  HeartbeatRequest,
  PublicKeyJwk,
  QueueAgentCommandRequest,
} from './agent.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const DISPLAY_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const CAPABILITIES = new Set<AgentCapability>([
  'greenhouse_fill',
  'lever_fill',
  'file_upload',
  'preview',
  'submit_after_confirmation',
]);
const COMMAND_TYPES = new Set<AgentCommandType>([
  'fill_application',
  'prepare_preview',
  'submit_application',
  'cancel_task',
]);
const RECEIPT_STATUSES = new Set([
  'accepted',
  'started',
  'paused',
  'completed',
  'rejected',
  'manual_intervention_required',
]);
const MANUAL_REASONS = new Set([
  'captcha',
  'assessment',
  'video_interview',
  'electronic_signature',
  'unknown_required_field',
  'legal_or_identity_question',
  'work_authorization_ambiguous',
  'page_structure_changed',
  'submission_result_uncertain',
  'credential_required',
  'policy_blocked',
  'evidence_conflict',
]);
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'password',
  'passwd',
  'username',
  'cookie',
  'cookies',
  'captcha',
  'captchavalue',
  'verificationcode',
  'onetimepassword',
  'sessionstorage',
  'localstorage',
  'browserprofile',
  'credential',
  'credentials',
]);

function validationError(): never {
  throw new AgentProtocolError('VALIDATION_FAILED');
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return validationError();
  }
  return value as Record<string, unknown>;
}

function rejectCredentialFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectCredentialFields);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll(/[_-]/g, '').toLowerCase();
    if (FORBIDDEN_CREDENTIAL_KEYS.has(normalized)) {
      throw new AgentProtocolError('CREDENTIAL_DATA_FORBIDDEN');
    }
    rejectCredentialFields(nested);
  }
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  rejectCredentialFields(value);
  const object = asObject(value);
  if (
    Object.keys(object).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(object, key))
  ) {
    return validationError();
  }
  return object;
}

function stringValue(
  value: unknown,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== 'string' ||
    value.length < (options.min ?? 0) ||
    value.length > (options.max ?? Number.POSITIVE_INFINITY) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    return validationError();
  }
  return value;
}

function integerValue(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return validationError();
  }
  return value as number;
}

function timestampValue(value: unknown): string {
  const timestamp = stringValue(value, { min: 20, max: 35 });
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || !timestamp.endsWith('Z')) {
    return validationError();
  }
  return timestamp;
}

function credentialFreeUrl(value: unknown): string {
  const urlValue = stringValue(value, { min: 1, max: 2048 });
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    return validationError();
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AgentProtocolError('CREDENTIAL_DATA_FORBIDDEN');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return validationError();
  }
  return urlValue;
}

function uuidValue(value: unknown): string {
  return stringValue(value, { pattern: UUID_PATTERN });
}

function uniqueStringArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  minimum: number,
  maximum: number,
): T[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((item) => typeof item !== 'string' || !allowed.has(item as T)) ||
    new Set(value).size !== value.length
  ) {
    return validationError();
  }
  return [...value] as T[];
}

export function validateIdempotencyKey(value: unknown): string {
  return stringValue(value, { min: 16, max: 128, pattern: /^[\x21-\x7e]+$/ });
}

export function validateAgentNonce(value: unknown): string {
  return stringValue(value, { min: 22, max: 256 });
}

export function validateAgentProof(value: unknown): string {
  return stringValue(value, { min: 43, max: 1024, pattern: BASE64URL_PATTERN });
}

export function validateUuid(value: unknown): string {
  return uuidValue(value);
}

export function validateCreatePairingSessionRequest(value: unknown): CreatePairingSessionRequest {
  const object = exactObject(value, ['requested_scopes'], ['requested_scopes']);
  return {
    requested_scopes: uniqueStringArray(
      object.requested_scopes,
      new Set<AgentScope>(AGENT_SCOPES),
      1,
      3,
    ),
  };
}

function validatePublicKeyJwk(value: unknown): PublicKeyJwk {
  const object = exactObject(value, ['kty', 'crv', 'x', 'y', 'kid'], ['kty', 'crv', 'x', 'y']);
  if (object.kty !== 'EC' || object.crv !== 'P-256') {
    return validationError();
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: stringValue(object.x, { min: 43, max: 43, pattern: BASE64URL_PATTERN }),
    y: stringValue(object.y, { min: 43, max: 43, pattern: BASE64URL_PATTERN }),
    ...(object.kid === undefined ? {} : { kid: stringValue(object.kid, { min: 1, max: 128 }) }),
  };
}

export function validateClaimPairingSessionRequest(value: unknown): ClaimPairingSessionRequest {
  const object = exactObject(
    value,
    [
      'pairing_secret',
      'device_name',
      'agent_version',
      'platform',
      'public_key_jwk',
      'challenge_signature',
    ],
    ['pairing_secret', 'device_name', 'public_key_jwk', 'challenge_signature'],
  );
  if (
    object.platform !== undefined &&
    !['windows', 'macos', 'linux'].includes(object.platform as string)
  ) {
    return validationError();
  }
  return {
    pairing_secret: stringValue(object.pairing_secret, { min: 43, max: 256 }),
    device_name: stringValue(object.device_name, { min: 1, max: 120 }),
    ...(object.agent_version === undefined
      ? {}
      : {
          agent_version: stringValue(object.agent_version, {
            pattern: VERSION_PATTERN,
          }),
        }),
    ...(object.platform === undefined
      ? {}
      : { platform: object.platform as 'windows' | 'macos' | 'linux' }),
    public_key_jwk: validatePublicKeyJwk(object.public_key_jwk),
    challenge_signature: stringValue(object.challenge_signature, {
      min: 43,
      max: 1024,
      pattern: BASE64URL_PATTERN,
    }),
  };
}

export function validateConfirmPairingSessionRequest(value: unknown): ConfirmPairingSessionRequest {
  const object = exactObject(
    value,
    ['display_code', 'public_key_thumbprint', 'approved'],
    ['display_code', 'public_key_thumbprint', 'approved'],
  );
  if (object.approved !== true) {
    return validationError();
  }
  return {
    display_code: stringValue(object.display_code, { pattern: DISPLAY_CODE_PATTERN }),
    public_key_thumbprint: stringValue(object.public_key_thumbprint, {
      min: 43,
      max: 128,
      pattern: BASE64URL_PATTERN,
    }),
    approved: true,
  };
}

export function validateAgentTokenRequest(value: unknown): AgentTokenRequest {
  rejectCredentialFields(value);
  const object = asObject(value);
  if (object.grant_type === 'authorization_code') {
    const exact = exactObject(
      object,
      ['grant_type', 'agent_id', 'authorization_code'],
      ['grant_type', 'agent_id', 'authorization_code'],
    );
    return {
      grant_type: 'authorization_code',
      agent_id: uuidValue(exact.agent_id),
      authorization_code: stringValue(exact.authorization_code, { min: 43, max: 256 }),
    };
  }
  if (object.grant_type === 'refresh_token') {
    const exact = exactObject(
      object,
      ['grant_type', 'agent_id', 'refresh_token'],
      ['grant_type', 'agent_id', 'refresh_token'],
    );
    return {
      grant_type: 'refresh_token',
      agent_id: uuidValue(exact.agent_id),
      refresh_token: stringValue(exact.refresh_token, { min: 43, max: 2048 }),
    };
  }
  return validationError();
}

export function validateClaimCommandRequest(value: unknown): ClaimCommandRequest {
  const object = exactObject(
    value,
    ['capabilities', 'wait_seconds'],
    ['capabilities', 'wait_seconds'],
  );
  return {
    capabilities: uniqueStringArray(object.capabilities, CAPABILITIES, 1, 20),
    wait_seconds: integerValue(object.wait_seconds, 0, 30),
  };
}

export function validateCommandReceiptRequest(value: unknown): CommandReceiptRequest {
  const object = exactObject(
    value,
    ['sequence', 'status', 'occurred_at', 'manual_reason', 'result'],
    ['sequence', 'status', 'occurred_at'],
  );
  if (typeof object.status !== 'string' || !RECEIPT_STATUSES.has(object.status)) {
    return validationError();
  }
  if (
    object.manual_reason !== undefined &&
    (typeof object.manual_reason !== 'string' || !MANUAL_REASONS.has(object.manual_reason))
  ) {
    return validationError();
  }
  let result: CommandReceiptRequest['result'];
  if (object.result !== undefined) {
    const resultObject = exactObject(
      object.result,
      ['confirmation_number', 'evidence_file_id', 'preview_hash'],
      [],
    );
    result = {
      ...(resultObject.confirmation_number === undefined
        ? {}
        : {
            confirmation_number: stringValue(resultObject.confirmation_number, {
              min: 1,
              max: 256,
            }),
          }),
      ...(resultObject.evidence_file_id === undefined
        ? {}
        : { evidence_file_id: uuidValue(resultObject.evidence_file_id) }),
      ...(resultObject.preview_hash === undefined
        ? {}
        : {
            preview_hash: stringValue(resultObject.preview_hash, {
              pattern: HASH_PATTERN,
            }),
          }),
    };
  }
  return {
    sequence: integerValue(object.sequence, 1, 1000),
    status: object.status as CommandReceiptRequest['status'],
    occurred_at: timestampValue(object.occurred_at),
    ...(object.manual_reason === undefined
      ? {}
      : {
          manual_reason: object.manual_reason as NonNullable<
            CommandReceiptRequest['manual_reason']
          >,
        }),
    ...(result === undefined ? {} : { result }),
  };
}

export function validateHeartbeatRequest(value: unknown): HeartbeatRequest {
  const object = exactObject(
    value,
    [
      'agent_version',
      'status',
      'capabilities',
      'authorization_version',
      'current_command_id',
      'observed_at',
    ],
    ['agent_version', 'status', 'capabilities', 'authorization_version', 'observed_at'],
  );
  if (typeof object.status !== 'string' || !['online', 'busy', 'paused'].includes(object.status)) {
    return validationError();
  }
  return {
    agent_version: stringValue(object.agent_version, { pattern: VERSION_PATTERN }),
    status: object.status as HeartbeatRequest['status'],
    capabilities: uniqueStringArray(object.capabilities, CAPABILITIES, 0, 20),
    authorization_version: integerValue(object.authorization_version, 1, Number.MAX_SAFE_INTEGER),
    ...(object.current_command_id === undefined
      ? {}
      : { current_command_id: uuidValue(object.current_command_id) }),
    observed_at: timestampValue(object.observed_at),
  };
}

function validateCommandPayload(value: unknown): AgentCommandPayload {
  const object = exactObject(
    value,
    [
      'task_id',
      'application_id',
      'target_url',
      'material_file_ids',
      'answer_fact_ids',
      'preview_hash',
    ],
    ['task_id'],
  );
  const uuidArray = (array: unknown, maximum: number): string[] => {
    if (!Array.isArray(array) || array.length > maximum || new Set(array).size !== array.length) {
      return validationError();
    }
    return array.map(uuidValue);
  };
  return {
    task_id: uuidValue(object.task_id),
    ...(object.application_id === undefined
      ? {}
      : { application_id: uuidValue(object.application_id) }),
    ...(object.target_url === undefined
      ? {}
      : { target_url: credentialFreeUrl(object.target_url) }),
    ...(object.material_file_ids === undefined
      ? {}
      : { material_file_ids: uuidArray(object.material_file_ids, 20) }),
    ...(object.answer_fact_ids === undefined
      ? {}
      : { answer_fact_ids: uuidArray(object.answer_fact_ids, 100) }),
    ...(object.preview_hash === undefined
      ? {}
      : {
          preview_hash: stringValue(object.preview_hash, {
            pattern: HASH_PATTERN,
          }),
        }),
  };
}

export function validateQueueAgentCommandRequest(value: unknown): QueueAgentCommandRequest {
  const object = exactObject(
    value,
    [
      'agent_id',
      'user_id',
      'tenant_id',
      'type',
      'idempotency_key',
      'expires_at',
      'resource',
      'payload',
      'confirmation_token',
    ],
    [
      'agent_id',
      'user_id',
      'tenant_id',
      'type',
      'idempotency_key',
      'expires_at',
      'resource',
      'payload',
    ],
  );
  if (typeof object.type !== 'string' || !COMMAND_TYPES.has(object.type as AgentCommandType)) {
    return validationError();
  }
  const resource = exactObject(
    object.resource,
    ['type', 'id', 'version'],
    ['type', 'id', 'version'],
  );
  if (resource.type !== 'application' && resource.type !== 'task') {
    return validationError();
  }
  return {
    agent_id: uuidValue(object.agent_id),
    user_id: uuidValue(object.user_id),
    tenant_id: uuidValue(object.tenant_id),
    type: object.type as AgentCommandType,
    idempotency_key: validateIdempotencyKey(object.idempotency_key),
    expires_at: timestampValue(object.expires_at),
    resource: {
      type: resource.type,
      id: uuidValue(resource.id),
      version: integerValue(resource.version, 1, Number.MAX_SAFE_INTEGER),
    },
    payload: validateCommandPayload(object.payload),
    ...(object.confirmation_token === undefined
      ? {}
      : {
          confirmation_token: stringValue(object.confirmation_token, {
            min: 43,
            max: 2048,
          }),
        }),
  };
}
