import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  buildAgentProofPayload,
  buildPairingChallengePayload,
  canonicalJson,
  publicKeyThumbprint,
  randomSecret,
  secretMatches,
  sha256Base64Url,
  signControlValue,
  verifyDeviceSignature,
} from './agent.crypto';
import { AgentProtocolError } from './agent.errors';
import {
  validateAgentNonce,
  validateAgentProof,
  validateAgentTokenRequest,
  validateClaimCommandRequest,
  validateClaimPairingSessionRequest,
  validateCommandReceiptRequest,
  validateConfirmPairingSessionRequest,
  validateCreatePairingSessionRequest,
  validateHeartbeatRequest,
  validateIdempotencyKey,
  validateQueueAgentCommandRequest,
  validateUuid,
} from './agent.validation';

import type {
  Agent,
  AgentAuditRecord,
  AgentClock,
  AgentCommand,
  AgentProofAuthentication,
  AgentRequestAuthentication,
  AgentScope,
  AgentServiceOptions,
  AgentTokenResponse,
  CommandReceipt,
  PairingClaimed,
  PairingConfirmed,
  PairingSessionCreated,
  PublicKeyJwk,
  QueueAgentCommandRequest,
  WebUserPrincipal,
} from './agent.types';

export const AGENT_SERVICE_OPTIONS = Symbol('AGENT_SERVICE_OPTIONS');

interface PairingRecord {
  id: string;
  userId: string;
  tenantId: string;
  scopes: AgentScope[];
  secretHash: string;
  challenge: string;
  displayCode: string;
  expiresAt: number;
  status: 'created' | 'claimed' | 'confirmed';
  deviceName?: string;
  publicKeyJwk?: PublicKeyJwk;
  publicKeyThumbprint?: string;
  agentId?: string;
}

interface AgentRecord {
  public: Agent;
  tenantId: string;
  publicKeyJwk: PublicKeyJwk;
}

interface AuthorizationCodeRecord {
  hash: string;
  agentId: string;
  expiresAt: number;
  consumed: boolean;
}

interface RefreshTokenRecord {
  hash: string;
  agentId: string;
  familyId: string;
  expiresAt: number;
  status: 'active' | 'rotated' | 'revoked';
}

interface AccessTokenRecord {
  hash: string;
  jti: string;
  issuer: string;
  subject: string;
  tenantId: string;
  userId: string;
  audience: string;
  scopes: AgentScope[];
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  publicKeyThumbprint: string;
  authorizationVersion: number;
  familyId: string;
}

interface IdempotencyRecord {
  requestHash: string;
  response: unknown;
}

interface StoredCommand {
  command: AgentCommand;
  agentId: string;
  userId: string;
  tenantId: string;
  status: 'queued' | 'leased' | 'finished' | 'cancelled';
  leaseExpiresAt?: number;
}

interface StoredReceipt {
  receipt: CommandReceipt;
  requestHash: string;
}

interface PreparedAuthorization<T> {
  agent: AgentRecord;
  access: AccessTokenRecord;
  nonce: string;
  idempotencyStoreKey: string;
  requestHash: string;
  replayed: boolean;
  replayedResponse?: T;
}

const DEFAULT_PAIRING_TTL_SECONDS = 600;
const DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS = 120;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 300;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const IDEMPOTENCY_VOID = Object.freeze({ completed: true });
const DISPLAY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class AgentService {
  private readonly clock: AgentClock;
  private readonly pairingTtlSeconds: number;
  private readonly authorizationCodeTtlSeconds: number;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly pairingUriOrigin: string;
  private readonly signingKey: Uint8Array;

  private readonly pairings = new Map<string, PairingRecord>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly revokedFamilies = new Set<string>();
  private readonly consumedAccessJtis = new Set<string>();
  private readonly consumedRequestNonces = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly commands = new Map<string, StoredCommand>();
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly audits: AgentAuditRecord[] = [];

  constructor(
    @Optional()
    @Inject(AGENT_SERVICE_OPTIONS)
    options: AgentServiceOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.pairingTtlSeconds = Math.min(
      DEFAULT_PAIRING_TTL_SECONDS,
      options.pairing_ttl_seconds ?? DEFAULT_PAIRING_TTL_SECONDS,
    );
    this.authorizationCodeTtlSeconds = Math.min(
      DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS,
      options.authorization_code_ttl_seconds ?? DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS,
    );
    this.accessTokenTtlSeconds = Math.min(
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      Math.max(60, options.access_token_ttl_seconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS),
    );
    this.refreshTokenTtlSeconds =
      options.refresh_token_ttl_seconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
    this.issuer = options.issuer ?? 'haitouwang-agent-control';
    this.audience = options.audience ?? 'local-agent-control';
    this.pairingUriOrigin = options.pairing_uri_origin ?? 'https://api.haitouwang.example';
    this.signingKey = options.signing_key ?? randomBytes(32);
  }

  createPairingSession(
    principalValue: WebUserPrincipal,
    bodyValue: unknown,
    idempotencyKeyValue: unknown,
  ): PairingSessionCreated {
    return this.audited(
      'agent.pairing_session_created',
      { user_id: principalValue?.user_id, tenant_id: principalValue?.tenant_id },
      () => {
        const principal = this.validatePrincipal(principalValue);
        const body = validateCreatePairingSessionRequest(bodyValue);
        const idempotencyKey = validateIdempotencyKey(idempotencyKeyValue);
        const requestHash = sha256Base64Url(canonicalJson(body));
        const storeKey = this.idempotencyKey(
          principal.user_id,
          'createAgentPairingSession',
          idempotencyKey,
        );
        const replay = this.readIdempotency<PairingSessionCreated>(storeKey, requestHash);
        if (replay.found) {
          return replay.response;
        }

        const now = this.nowMs();
        const id = randomUUID();
        const pairingSecret = randomSecret();
        const challenge = randomSecret();
        const displayCode = this.createDisplayCode();
        const expiresAt = now + this.pairingTtlSeconds * 1000;
        const response: PairingSessionCreated = {
          pairing_session_id: id,
          pairing_secret: pairingSecret,
          pairing_uri: `${this.pairingUriOrigin}/agent/pair?session_id=${encodeURIComponent(id)}&secret=${encodeURIComponent(pairingSecret)}`,
          display_code: displayCode,
          challenge,
          expires_at: new Date(expiresAt).toISOString(),
        };
        this.pairings.set(id, {
          id,
          userId: principal.user_id,
          tenantId: principal.tenant_id,
          scopes: body.requested_scopes,
          secretHash: sha256Base64Url(pairingSecret),
          challenge,
          displayCode,
          expiresAt,
          status: 'created',
        });
        this.writeIdempotency(storeKey, requestHash, response);
        return response;
      },
    );
  }

  claimPairingSession(
    pairingSessionIdValue: unknown,
    bodyValue: unknown,
    idempotencyKeyValue: unknown,
  ): PairingClaimed {
    return this.audited(
      'agent.pairing_claimed_or_rejected',
      {
        pairing_session_id:
          typeof pairingSessionIdValue === 'string' ? pairingSessionIdValue : undefined,
      },
      () => {
        const pairingSessionId = validateUuid(pairingSessionIdValue);
        const body = validateClaimPairingSessionRequest(bodyValue);
        const idempotencyKey = validateIdempotencyKey(idempotencyKeyValue);
        const record = this.pairings.get(pairingSessionId);
        if (record === undefined) {
          throw new AgentProtocolError('PAIRING_CODE_INVALID');
        }
        const requestHash = sha256Base64Url(canonicalJson(body));
        const storeKey = this.idempotencyKey(
          pairingSessionId,
          'claimAgentPairingSession',
          idempotencyKey,
        );

        if (
          this.nowMs() > record.expiresAt ||
          !secretMatches(body.pairing_secret, record.secretHash) ||
          !verifyDeviceSignature(
            body.public_key_jwk,
            buildPairingChallengePayload(record.id, record.challenge),
            body.challenge_signature,
          )
        ) {
          throw new AgentProtocolError('PAIRING_CODE_INVALID');
        }

        const replay = this.readIdempotency<PairingClaimed>(storeKey, requestHash);
        if (replay.found) {
          return replay.response;
        }
        if (record.status !== 'created') {
          throw new AgentProtocolError('REPLAY_DETECTED');
        }

        const thumbprint = publicKeyThumbprint(body.public_key_jwk);
        record.status = 'claimed';
        record.deviceName = body.device_name;
        record.publicKeyJwk = body.public_key_jwk;
        record.publicKeyThumbprint = thumbprint;
        const response: PairingClaimed = {
          pairing_session_id: record.id,
          status: 'claimed',
          device_name: body.device_name,
          public_key_thumbprint: thumbprint,
          display_code: record.displayCode,
          expires_at: new Date(record.expiresAt).toISOString(),
        };
        this.writeIdempotency(storeKey, requestHash, response);
        return response;
      },
    );
  }

  confirmPairingSession(
    principalValue: WebUserPrincipal,
    pairingSessionIdValue: unknown,
    bodyValue: unknown,
    idempotencyKeyValue: unknown,
  ): PairingConfirmed {
    return this.audited(
      'agent.pairing_confirmed',
      {
        user_id: principalValue?.user_id,
        tenant_id: principalValue?.tenant_id,
        pairing_session_id:
          typeof pairingSessionIdValue === 'string' ? pairingSessionIdValue : undefined,
      },
      () => {
        const principal = this.validatePrincipal(principalValue);
        const pairingSessionId = validateUuid(pairingSessionIdValue);
        const body = validateConfirmPairingSessionRequest(bodyValue);
        const idempotencyKey = validateIdempotencyKey(idempotencyKeyValue);
        const record = this.pairings.get(pairingSessionId);
        if (
          record === undefined ||
          record.userId !== principal.user_id ||
          record.tenantId !== principal.tenant_id ||
          this.nowMs() > record.expiresAt
        ) {
          throw new AgentProtocolError('PAIRING_CODE_INVALID');
        }
        const requestHash = sha256Base64Url(canonicalJson(body));
        const storeKey = this.idempotencyKey(
          principal.user_id,
          `confirmAgentPairingSession:${pairingSessionId}`,
          idempotencyKey,
        );
        const replay = this.readIdempotency<PairingConfirmed>(storeKey, requestHash);
        if (replay.found) {
          return replay.response;
        }
        if (record.status !== 'claimed') {
          throw new AgentProtocolError('REPLAY_DETECTED');
        }
        if (
          body.display_code !== record.displayCode ||
          body.public_key_thumbprint !== record.publicKeyThumbprint ||
          record.deviceName === undefined ||
          record.publicKeyJwk === undefined ||
          record.publicKeyThumbprint === undefined
        ) {
          throw new AgentProtocolError('PAIRING_CODE_INVALID');
        }

        const now = this.nowMs();
        const agentId = randomUUID();
        const agent: Agent = {
          id: agentId,
          user_id: record.userId,
          device_name: record.deviceName,
          public_key_thumbprint: record.publicKeyThumbprint,
          status: 'offline',
          scopes: [...record.scopes],
          authorization_version: 1,
          version: 1,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        };
        this.agents.set(agentId, {
          public: agent,
          tenantId: record.tenantId,
          publicKeyJwk: record.publicKeyJwk,
        });
        record.status = 'confirmed';
        record.agentId = agentId;

        const authorizationCode = randomSecret();
        const authorizationCodeExpiresAt = now + this.authorizationCodeTtlSeconds * 1000;
        const authorizationCodeHash = sha256Base64Url(authorizationCode);
        this.authorizationCodes.set(authorizationCodeHash, {
          hash: authorizationCodeHash,
          agentId,
          expiresAt: authorizationCodeExpiresAt,
          consumed: false,
        });
        const response: PairingConfirmed = {
          agent: structuredClone(agent),
          authorization_code: authorizationCode,
          authorization_code_expires_at: new Date(authorizationCodeExpiresAt).toISOString(),
        };
        this.writeIdempotency(storeKey, requestHash, response);
        return response;
      },
    );
  }

  exchangeAgentToken(
    bodyValue: unknown,
    authenticationValue: AgentProofAuthentication,
  ): AgentTokenResponse {
    return this.audited('agent.token_issued_or_rejected', {}, () => {
      const body = validateAgentTokenRequest(bodyValue);
      const authentication = this.validateProofAuthentication(authenticationValue);
      const agent = this.getAgent(body.agent_id);
      this.assertAgentActive(agent);
      this.verifyProof(
        agent,
        'POST',
        '/v1/agent-tokens',
        authentication.nonce,
        body,
        authentication.proof,
      );
      const requestHash = sha256Base64Url(canonicalJson(body));
      const storeKey = this.idempotencyKey(
        agent.public.id,
        'exchangeAgentToken',
        authentication.idempotency_key,
      );
      const replay = this.readIdempotency<AgentTokenResponse>(storeKey, requestHash);
      if (replay.found) {
        return replay.response;
      }
      this.assertUnusedNonce(agent.public.id, authentication.nonce);

      let familyId: string;
      if (body.grant_type === 'authorization_code') {
        const codeHash = sha256Base64Url(body.authorization_code);
        const code = this.authorizationCodes.get(codeHash);
        if (code === undefined || code.agentId !== agent.public.id) {
          throw new AgentProtocolError('AUTH_REQUIRED');
        }
        if (this.nowMs() > code.expiresAt) {
          throw new AgentProtocolError('TOKEN_EXPIRED');
        }
        if (code.consumed) {
          throw new AgentProtocolError('REPLAY_DETECTED');
        }
        code.consumed = true;
        familyId = randomUUID();
      } else {
        const refreshHash = sha256Base64Url(body.refresh_token);
        const refresh = this.refreshTokens.get(refreshHash);
        if (refresh === undefined || refresh.agentId !== agent.public.id) {
          throw new AgentProtocolError('AUTH_REQUIRED');
        }
        if (refresh.status !== 'active') {
          this.revokeAuthorization(agent, refresh.familyId);
          throw new AgentProtocolError('REPLAY_DETECTED');
        }
        if (this.nowMs() > refresh.expiresAt) {
          refresh.status = 'revoked';
          throw new AgentProtocolError('TOKEN_EXPIRED');
        }
        refresh.status = 'rotated';
        familyId = refresh.familyId;
      }

      this.consumedRequestNonces.add(this.nonceKey(agent.public.id, authentication.nonce));
      const response = this.issueTokenPair(agent, familyId);
      this.writeIdempotency(storeKey, requestHash, response);
      return response;
    });
  }

  claimCommand(
    agentIdValue: unknown,
    bodyValue: unknown,
    authenticationValue: AgentRequestAuthentication,
  ): AgentCommand | undefined {
    return this.audited(
      'agent.command_claimed_or_rejected',
      { agent_id: typeof agentIdValue === 'string' ? agentIdValue : undefined },
      () => {
        const agentId = validateUuid(agentIdValue);
        const body = validateClaimCommandRequest(bodyValue);
        const authentication = this.validateRequestAuthentication(authenticationValue);
        const authorization = this.prepareAuthorization<AgentCommand | undefined>(
          agentId,
          'agent:commands:claim',
          'POST',
          `/v1/agents/${agentId}/commands:claim`,
          body,
          authentication,
          'claimAgentCommand',
        );
        if (authorization.replayed) {
          return authorization.replayedResponse;
        }

        const now = this.nowMs();
        const command = [...this.commands.values()].find(
          (candidate) =>
            candidate.agentId === agentId &&
            candidate.userId === authorization.agent.public.user_id &&
            candidate.tenantId === authorization.agent.tenantId &&
            candidate.status === 'queued' &&
            Date.parse(candidate.command.expires_at) >= now &&
            this.commandMatchesCapabilities(candidate.command, body.capabilities),
        );
        this.consumeAuthorization(authorization);
        let response: AgentCommand | undefined;
        if (command !== undefined) {
          command.status = 'leased';
          command.leaseExpiresAt = Math.min(now + 60_000, Date.parse(command.command.expires_at));
          response = structuredClone(command.command);
        }
        this.writeIdempotency(
          authorization.idempotencyStoreKey,
          authorization.requestHash,
          response,
        );
        return response;
      },
    );
  }

  createCommandReceipt(
    agentIdValue: unknown,
    commandIdValue: unknown,
    bodyValue: unknown,
    authenticationValue: AgentRequestAuthentication,
  ): CommandReceipt {
    return this.audited(
      'agent.command_receipt_recorded_or_rejected',
      {
        agent_id: typeof agentIdValue === 'string' ? agentIdValue : undefined,
      },
      () => {
        const agentId = validateUuid(agentIdValue);
        const commandId = validateUuid(commandIdValue);
        const body = validateCommandReceiptRequest(bodyValue);
        const authentication = this.validateRequestAuthentication(authenticationValue);
        const authorization = this.prepareAuthorization<CommandReceipt>(
          agentId,
          'agent:receipts:write',
          'POST',
          `/v1/agents/${agentId}/commands/${commandId}/receipts`,
          body,
          authentication,
          'createAgentCommandReceipt',
        );
        if (authorization.replayed) {
          return authorization.replayedResponse as CommandReceipt;
        }
        const command = this.commands.get(commandId);
        if (
          command === undefined ||
          command.agentId !== agentId ||
          command.userId !== authorization.agent.public.user_id ||
          command.tenantId !== authorization.agent.tenantId
        ) {
          throw new AgentProtocolError('RESOURCE_NOT_FOUND');
        }

        const requestHash = sha256Base64Url(canonicalJson(body));
        const receiptKey = `${agentId}:${commandId}:${body.sequence}`;
        const existing = this.receipts.get(receiptKey);
        if (existing !== undefined) {
          if (existing.requestHash !== requestHash) {
            throw new AgentProtocolError('CONFLICT');
          }
          this.consumeAuthorization(authorization);
          this.writeIdempotency(
            authorization.idempotencyStoreKey,
            authorization.requestHash,
            existing.receipt,
          );
          return structuredClone(existing.receipt);
        }

        this.consumeAuthorization(authorization);
        const now = this.nowMs();
        const receipt: CommandReceipt = {
          receipt_id: randomUUID(),
          agent_id: agentId,
          command_id: commandId,
          sequence: body.sequence,
          status: body.status,
          recorded_at: new Date(now).toISOString(),
        };
        this.receipts.set(receiptKey, { receipt, requestHash });
        if (body.status === 'accepted') {
          command.status = 'leased';
          command.leaseExpiresAt = Math.min(now + 60_000, Date.parse(command.command.expires_at));
        }
        if (['completed', 'rejected', 'manual_intervention_required'].includes(body.status)) {
          command.status = 'finished';
        }
        this.writeIdempotency(
          authorization.idempotencyStoreKey,
          authorization.requestHash,
          receipt,
        );
        return structuredClone(receipt);
      },
    );
  }

  heartbeat(
    agentIdValue: unknown,
    bodyValue: unknown,
    authenticationValue: AgentRequestAuthentication,
  ): void {
    this.audited(
      'agent.heartbeat_recorded_or_rejected',
      { agent_id: typeof agentIdValue === 'string' ? agentIdValue : undefined },
      () => {
        const agentId = validateUuid(agentIdValue);
        const body = validateHeartbeatRequest(bodyValue);
        const authentication = this.validateRequestAuthentication(authenticationValue);
        const authorization = this.prepareAuthorization<typeof IDEMPOTENCY_VOID>(
          agentId,
          'agent:heartbeat:write',
          'POST',
          `/v1/agents/${agentId}/heartbeat`,
          body,
          authentication,
          'heartbeatAgent',
        );
        if (authorization.replayed) {
          return;
        }
        if (body.authorization_version !== authorization.agent.public.authorization_version) {
          throw new AgentProtocolError('TOKEN_REVOKED');
        }
        if (
          body.current_command_id !== undefined &&
          this.commands.get(body.current_command_id)?.agentId !== agentId
        ) {
          throw new AgentProtocolError('RESOURCE_NOT_FOUND');
        }
        this.consumeAuthorization(authorization);
        const nowIso = new Date(this.nowMs()).toISOString();
        authorization.agent.public.status = 'online';
        authorization.agent.public.last_seen_at = nowIso;
        authorization.agent.public.updated_at = nowIso;
        authorization.agent.public.version += 1;
        if (body.current_command_id !== undefined) {
          const command = this.commands.get(body.current_command_id);
          if (command !== undefined && command.status === 'leased') {
            command.leaseExpiresAt = Math.min(
              this.nowMs() + 60_000,
              Date.parse(command.command.expires_at),
            );
          }
        }
        this.writeIdempotency(
          authorization.idempotencyStoreKey,
          authorization.requestHash,
          IDEMPOTENCY_VOID,
        );
      },
    );
  }

  revokeAgent(
    principalValue: WebUserPrincipal,
    agentIdValue: unknown,
    idempotencyKeyValue: unknown,
  ): Agent {
    return this.audited(
      'agent.authorization_revoked',
      {
        user_id: principalValue?.user_id,
        tenant_id: principalValue?.tenant_id,
        agent_id: typeof agentIdValue === 'string' ? agentIdValue : undefined,
      },
      () => {
        const principal = this.validatePrincipal(principalValue);
        const agentId = validateUuid(agentIdValue);
        const idempotencyKey = validateIdempotencyKey(idempotencyKeyValue);
        const requestHash = sha256Base64Url(canonicalJson({ agent_id: agentId }));
        const storeKey = this.idempotencyKey(
          principal.user_id,
          `revokeAgent:${agentId}`,
          idempotencyKey,
        );
        const replay = this.readIdempotency<Agent>(storeKey, requestHash);
        if (replay.found) {
          return replay.response;
        }
        const agent = this.getAgent(agentId);
        if (agent.public.user_id !== principal.user_id || agent.tenantId !== principal.tenant_id) {
          throw new AgentProtocolError('RESOURCE_NOT_FOUND');
        }
        if (agent.public.status === 'revoked') {
          throw new AgentProtocolError('CONFLICT');
        }
        this.revokeAuthorization(agent);
        const response = structuredClone(agent.public);
        this.writeIdempotency(storeKey, requestHash, response);
        return response;
      },
    );
  }

  queueCommand(value: unknown): AgentCommand {
    const request = validateQueueAgentCommandRequest(value);
    const agent = this.getAgent(request.agent_id);
    this.assertAgentActive(agent);
    if (agent.public.user_id !== request.user_id || agent.tenantId !== request.tenant_id) {
      throw new AgentProtocolError('FORBIDDEN');
    }
    if (Date.parse(request.expires_at) <= this.nowMs()) {
      throw new AgentProtocolError('VALIDATION_FAILED');
    }
    const duplicate = [...this.commands.values()].find(
      (stored) =>
        stored.agentId === request.agent_id &&
        stored.command.idempotency_key === request.idempotency_key,
    );
    if (duplicate !== undefined) {
      return structuredClone(duplicate.command);
    }
    const nowIso = new Date(this.nowMs()).toISOString();
    const unsigned = {
      command_id: randomUUID(),
      type: request.type,
      idempotency_key: request.idempotency_key,
      nonce: randomSecret(),
      issued_at: nowIso,
      expires_at: request.expires_at,
      resource: request.resource,
      payload: request.payload,
      ...(request.confirmation_token === undefined
        ? {}
        : { confirmation_token: request.confirmation_token }),
    };
    const command: AgentCommand = {
      ...unsigned,
      signature: signControlValue(this.signingKey, unsigned),
    };
    this.commands.set(command.command_id, {
      command,
      agentId: request.agent_id,
      userId: request.user_id,
      tenantId: request.tenant_id,
      status: 'queued',
    });
    return structuredClone(command);
  }

  sweepOfflineAgents(): number {
    const cutoff = this.nowMs() - 90_000;
    let updated = 0;
    for (const agent of this.agents.values()) {
      if (
        agent.public.status === 'online' &&
        agent.public.last_seen_at !== undefined &&
        Date.parse(agent.public.last_seen_at) < cutoff
      ) {
        agent.public.status = 'offline';
        agent.public.updated_at = new Date(this.nowMs()).toISOString();
        agent.public.version += 1;
        updated += 1;
      }
    }
    return updated;
  }

  getAuditRecords(): readonly AgentAuditRecord[] {
    return structuredClone(this.audits);
  }

  private prepareAuthorization<T>(
    agentId: string,
    requiredScope: AgentScope,
    method: string,
    path: string,
    body: unknown,
    authentication: AgentRequestAuthentication,
    operation: string,
  ): PreparedAuthorization<T> {
    const access = this.accessTokens.get(sha256Base64Url(authentication.access_token));
    if (access === undefined) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    const now = this.nowMs();
    if (now > access.expiresAt) {
      throw new AgentProtocolError('TOKEN_EXPIRED');
    }
    if (now < access.notBefore) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    if (
      access.issuer !== this.issuer ||
      access.audience !== this.audience ||
      access.subject !== agentId
    ) {
      throw new AgentProtocolError('FORBIDDEN');
    }
    const agent = this.getAgent(agentId);
    if (
      agent.public.status === 'revoked' ||
      access.authorizationVersion !== agent.public.authorization_version ||
      this.revokedFamilies.has(access.familyId)
    ) {
      throw new AgentProtocolError('TOKEN_REVOKED');
    }
    if (
      access.userId !== agent.public.user_id ||
      access.tenantId !== agent.tenantId ||
      access.publicKeyThumbprint !== agent.public.public_key_thumbprint
    ) {
      throw new AgentProtocolError('FORBIDDEN');
    }
    if (!access.scopes.includes(requiredScope)) {
      throw new AgentProtocolError('TOKEN_SCOPE_INSUFFICIENT');
    }
    this.verifyProof(agent, method, path, authentication.nonce, body, authentication.proof);
    const requestHash = sha256Base64Url(canonicalJson(body));
    const idempotencyStoreKey = this.idempotencyKey(
      agentId,
      operation,
      authentication.idempotency_key,
    );
    const replay = this.readIdempotency<T>(idempotencyStoreKey, requestHash);
    if (replay.found) {
      return {
        agent,
        access,
        nonce: authentication.nonce,
        idempotencyStoreKey,
        requestHash,
        replayed: true,
        replayedResponse: replay.response,
      };
    }
    this.assertUnusedNonce(agentId, authentication.nonce);
    if (this.consumedAccessJtis.has(access.jti)) {
      throw new AgentProtocolError('REPLAY_DETECTED');
    }
    return {
      agent,
      access,
      nonce: authentication.nonce,
      idempotencyStoreKey,
      requestHash,
      replayed: false,
    };
  }

  private consumeAuthorization(authorization: PreparedAuthorization<unknown>): void {
    this.consumedAccessJtis.add(authorization.access.jti);
    this.consumedRequestNonces.add(
      this.nonceKey(authorization.agent.public.id, authorization.nonce),
    );
  }

  private issueTokenPair(agent: AgentRecord, familyId: string): AgentTokenResponse {
    const now = this.nowMs();
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    const accessHash = sha256Base64Url(accessToken);
    const refreshHash = sha256Base64Url(refreshToken);
    this.accessTokens.set(accessHash, {
      hash: accessHash,
      jti: randomUUID(),
      issuer: this.issuer,
      subject: agent.public.id,
      tenantId: agent.tenantId,
      userId: agent.public.user_id,
      audience: this.audience,
      scopes: [...agent.public.scopes],
      issuedAt: now,
      notBefore: now,
      expiresAt: now + this.accessTokenTtlSeconds * 1000,
      publicKeyThumbprint: agent.public.public_key_thumbprint,
      authorizationVersion: agent.public.authorization_version,
      familyId,
    });
    this.refreshTokens.set(refreshHash, {
      hash: refreshHash,
      agentId: agent.public.id,
      familyId,
      expiresAt: now + this.refreshTokenTtlSeconds * 1000,
      status: 'active',
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: agent.public.scopes.join(' '),
      authorization_version: agent.public.authorization_version,
    };
  }

  private revokeAuthorization(agent: AgentRecord, familyId?: string): void {
    if (familyId !== undefined) {
      this.revokedFamilies.add(familyId);
    }
    for (const refresh of this.refreshTokens.values()) {
      if (refresh.agentId === agent.public.id) {
        refresh.status = 'revoked';
        this.revokedFamilies.add(refresh.familyId);
      }
    }
    const nowIso = new Date(this.nowMs()).toISOString();
    agent.public.status = 'revoked';
    agent.public.authorization_version += 1;
    agent.public.version += 1;
    agent.public.updated_at = nowIso;
    for (const command of this.commands.values()) {
      if (command.agentId === agent.public.id && command.status === 'queued') {
        command.status = 'cancelled';
      }
    }
  }

  private commandMatchesCapabilities(
    command: AgentCommand,
    capabilities: readonly string[],
  ): boolean {
    if (command.type === 'prepare_preview') {
      return capabilities.includes('preview');
    }
    if (command.type === 'submit_application') {
      return capabilities.includes('submit_after_confirmation');
    }
    return true;
  }

  private verifyProof(
    agent: AgentRecord,
    method: string,
    path: string,
    nonce: string,
    body: unknown,
    proof: string,
  ): void {
    if (
      !verifyDeviceSignature(
        agent.publicKeyJwk,
        buildAgentProofPayload(method, path, nonce, body),
        proof,
      )
    ) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
  }

  private validateRequestAuthentication(
    value: AgentRequestAuthentication,
  ): AgentRequestAuthentication {
    if (value === undefined || typeof value.access_token !== 'string') {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    if (value.access_token.length < 43 || value.access_token.length > 4096) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    return {
      access_token: value.access_token,
      nonce: validateAgentNonce(value.nonce),
      proof: validateAgentProof(value.proof),
      idempotency_key: validateIdempotencyKey(value.idempotency_key),
    };
  }

  private validateProofAuthentication(value: AgentProofAuthentication): AgentProofAuthentication {
    if (value === undefined) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    return {
      nonce: validateAgentNonce(value.nonce),
      proof: validateAgentProof(value.proof),
      idempotency_key: validateIdempotencyKey(value.idempotency_key),
    };
  }

  private validatePrincipal(value: WebUserPrincipal): WebUserPrincipal {
    if (value === undefined) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    return {
      user_id: validateUuid(value.user_id),
      tenant_id: validateUuid(value.tenant_id),
    };
  }

  private getAgent(agentId: string): AgentRecord {
    const agent = this.agents.get(agentId);
    if (agent === undefined) {
      throw new AgentProtocolError('RESOURCE_NOT_FOUND');
    }
    return agent;
  }

  private assertAgentActive(agent: AgentRecord): void {
    if (agent.public.status === 'revoked') {
      throw new AgentProtocolError('TOKEN_REVOKED');
    }
  }

  private assertUnusedNonce(agentId: string, nonce: string): void {
    if (this.consumedRequestNonces.has(this.nonceKey(agentId, nonce))) {
      throw new AgentProtocolError('REPLAY_DETECTED');
    }
  }

  private nonceKey(agentId: string, nonce: string): string {
    return `${agentId}:${sha256Base64Url(nonce)}`;
  }

  private idempotencyKey(principal: string, operation: string, key: string): string {
    return `${principal}:${operation}:${sha256Base64Url(key)}`;
  }

  private readIdempotency<T>(
    key: string,
    requestHash: string,
  ): { found: false } | { found: true; response: T } {
    const record = this.idempotency.get(key);
    if (record === undefined) {
      return { found: false };
    }
    if (record.requestHash !== requestHash) {
      throw new AgentProtocolError('IDEMPOTENCY_KEY_REUSED');
    }
    return { found: true, response: structuredClone(record.response) as T };
  }

  private writeIdempotency(key: string, requestHash: string, response: unknown): void {
    this.idempotency.set(key, {
      requestHash,
      response: structuredClone(response),
    });
  }

  private createDisplayCode(): string {
    const bytes = randomBytes(8);
    const characters = [...bytes].map((value) => DISPLAY_ALPHABET[value % DISPLAY_ALPHABET.length]);
    return `${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  private audited<T>(
    action: string,
    identifiers: Omit<AgentAuditRecord, 'occurred_at' | 'action' | 'result' | 'reason'>,
    callback: () => T,
  ): T {
    try {
      const result = callback();
      this.audits.push({
        occurred_at: new Date(this.nowMs()).toISOString(),
        action,
        result: 'accepted',
        ...identifiers,
      });
      return result;
    } catch (error) {
      const protocolError =
        error instanceof AgentProtocolError ? error : new AgentProtocolError('INTERNAL_ERROR');
      this.audits.push({
        occurred_at: new Date(this.nowMs()).toISOString(),
        action,
        result: 'rejected',
        reason: protocolError.code,
        ...identifiers,
      });
      throw protocolError;
    }
  }
}

export type { QueueAgentCommandRequest };
