import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AgentProtocolError,
  AgentService,
  buildAgentProofPayload,
  buildPairingChallengePayload,
} from '../../src/modules/agent';

import type {
  AgentProofAuthentication,
  AgentRequestAuthentication,
  AgentScope,
  AgentServiceOptions,
  AgentTokenRequest,
  AgentTokenResponse,
  PublicKeyJwk,
  WebUserPrincipal,
} from '../../src/modules/agent';
import type { KeyObject } from 'node:crypto';

class FakeClock {
  constructor(private timestamp = Date.parse('2026-07-30T20:00:00.000Z')) {}

  now(): Date {
    return new Date(this.timestamp);
  }

  advance(milliseconds: number): void {
    this.timestamp += milliseconds;
  }
}

interface PairedAgent {
  principal: WebUserPrincipal;
  privateKey: KeyObject;
  agentId: string;
  authorizationCode: string;
}

const ALL_SCOPES: AgentScope[] = [
  'agent:commands:claim',
  'agent:receipts:write',
  'agent:heartbeat:write',
];

function idempotencyKey(label: string): string {
  return `${label}:${randomUUID()}`;
}

function nonce(): string {
  return `nonce:${randomUUID()}`;
}

function deviceProof(
  privateKey: KeyObject,
  method: string,
  path: string,
  requestNonce: string,
  body: unknown,
): string {
  return sign(
    'sha256',
    Buffer.from(buildAgentProofPayload(method, path, requestNonce, body)),
    privateKey,
  ).toString('base64url');
}

function proofAuthentication(
  privateKey: KeyObject,
  body: unknown,
  key = idempotencyKey('token'),
): AgentProofAuthentication {
  const requestNonce = nonce();
  return {
    idempotency_key: key,
    nonce: requestNonce,
    proof: deviceProof(privateKey, 'POST', '/v1/agent-tokens', requestNonce, body),
  };
}

function requestAuthentication(
  privateKey: KeyObject,
  accessToken: string,
  path: string,
  body: unknown,
  key = idempotencyKey('request'),
  requestNonce = nonce(),
): AgentRequestAuthentication {
  return {
    access_token: accessToken,
    idempotency_key: key,
    nonce: requestNonce,
    proof: deviceProof(privateKey, 'POST', path, requestNonce, body),
  };
}

function pairAgent(service: AgentService, scopes: AgentScope[] = ALL_SCOPES): PairedAgent {
  const principal = {
    user_id: randomUUID(),
    tenant_id: randomUUID(),
  };
  const pairing = service.createPairingSession(
    principal,
    { requested_scopes: scopes },
    idempotencyKey('create-pairing'),
  );
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const publicKeyJwk = publicKey.export({ format: 'jwk' }) as PublicKeyJwk;
  const challengeSignature = sign(
    'sha256',
    Buffer.from(buildPairingChallengePayload(pairing.pairing_session_id, pairing.challenge)),
    privateKey,
  ).toString('base64url');
  const claimBody = {
    pairing_secret: pairing.pairing_secret,
    device_name: 'Security test device',
    agent_version: '1.0.0',
    platform: 'windows' as const,
    public_key_jwk: publicKeyJwk,
    challenge_signature: challengeSignature,
  };
  const claimKey = idempotencyKey('claim-pairing');
  const claimed = service.claimPairingSession(pairing.pairing_session_id, claimBody, claimKey);

  expect(service.claimPairingSession(pairing.pairing_session_id, claimBody, claimKey)).toEqual(
    claimed,
  );

  const confirmed = service.confirmPairingSession(
    principal,
    pairing.pairing_session_id,
    {
      display_code: claimed.display_code,
      public_key_thumbprint: claimed.public_key_thumbprint,
      approved: true,
    },
    idempotencyKey('confirm-pairing'),
  );
  return {
    principal,
    privateKey,
    agentId: confirmed.agent.id,
    authorizationCode: confirmed.authorization_code,
  };
}

function exchangeAuthorizationCode(service: AgentService, paired: PairedAgent): AgentTokenResponse {
  const body: AgentTokenRequest = {
    grant_type: 'authorization_code',
    agent_id: paired.agentId,
    authorization_code: paired.authorizationCode,
  };
  return service.exchangeAgentToken(body, proofAuthentication(paired.privateKey, body));
}

function rotateRefreshToken(
  service: AgentService,
  paired: PairedAgent,
  refreshToken: string,
): AgentTokenResponse {
  const body: AgentTokenRequest = {
    grant_type: 'refresh_token',
    agent_id: paired.agentId,
    refresh_token: refreshToken,
  };
  return service.exchangeAgentToken(body, proofAuthentication(paired.privateKey, body));
}

function expectProtocolError(callback: () => unknown, code: string): AgentProtocolError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentProtocolError);
    expect((error as AgentProtocolError).code).toBe(code);
    return error as AgentProtocolError;
  }
  throw new Error(`Expected AgentProtocolError ${code}.`);
}

describe('agent pairing and token security', () => {
  it('rejects expired one-time pairing material with the uniform pairing error', () => {
    const clock = new FakeClock();
    const service = new AgentService({ clock });
    const principal = { user_id: randomUUID(), tenant_id: randomUUID() };
    const pairing = service.createPairingSession(
      principal,
      { requested_scopes: ALL_SCOPES },
      idempotencyKey('expired-pairing'),
    );
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const publicKeyJwk = publicKey.export({ format: 'jwk' }) as PublicKeyJwk;
    const challengeSignature = sign(
      'sha256',
      Buffer.from(buildPairingChallengePayload(pairing.pairing_session_id, pairing.challenge)),
      privateKey,
    ).toString('base64url');
    clock.advance(601_000);

    expectProtocolError(
      () =>
        service.claimPairingSession(
          pairing.pairing_session_id,
          {
            pairing_secret: pairing.pairing_secret,
            device_name: 'Late device',
            public_key_jwk: publicKeyJwk,
            challenge_signature: challengeSignature,
          },
          idempotencyKey('late-claim'),
        ),
      'PAIRING_CODE_INVALID',
    );
  });

  it('rejects an expired short-lived access token', () => {
    const clock = new FakeClock();
    const service = new AgentService({ clock });
    const paired = pairAgent(service);
    const tokens = exchangeAuthorizationCode(service, paired);
    const body = { capabilities: ['preview'] as const, wait_seconds: 0 };
    const path = `/v1/agents/${paired.agentId}/commands:claim`;
    clock.advance(301_000);

    expectProtocolError(
      () =>
        service.claimCommand(
          paired.agentId,
          body,
          requestAuthentication(paired.privateKey, tokens.access_token, path, body),
        ),
      'TOKEN_EXPIRED',
    );
  });

  it('rejects a token outside its least-privilege scope', () => {
    const service = new AgentService();
    const paired = pairAgent(service, ['agent:heartbeat:write']);
    const tokens = exchangeAuthorizationCode(service, paired);
    const body = { capabilities: ['preview'] as const, wait_seconds: 0 };
    const path = `/v1/agents/${paired.agentId}/commands:claim`;

    expectProtocolError(
      () =>
        service.claimCommand(
          paired.agentId,
          body,
          requestAuthentication(paired.privateKey, tokens.access_token, path, body),
        ),
      'TOKEN_SCOPE_INSUFFICIENT',
    );
  });

  it('rejects a stolen token without proof from the paired device key', () => {
    const service = new AgentService();
    const paired = pairAgent(service);
    const tokens = exchangeAuthorizationCode(service, paired);
    const { privateKey: attackerKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const body = { capabilities: ['preview'] as const, wait_seconds: 0 };
    const path = `/v1/agents/${paired.agentId}/commands:claim`;

    expectProtocolError(
      () =>
        service.claimCommand(
          paired.agentId,
          body,
          requestAuthentication(attackerKey, tokens.access_token, path, body),
        ),
      'AUTH_REQUIRED',
    );
  });

  it('returns the first response for a legal retry and rejects token replay for a new intent', () => {
    const service = new AgentService();
    const paired = pairAgent(service);
    const tokens = exchangeAuthorizationCode(service, paired);
    const body = { capabilities: ['preview'] as const, wait_seconds: 0 };
    const path = `/v1/agents/${paired.agentId}/commands:claim`;
    const authentication = requestAuthentication(
      paired.privateKey,
      tokens.access_token,
      path,
      body,
    );

    expect(service.claimCommand(paired.agentId, body, authentication)).toBeUndefined();
    expect(service.claimCommand(paired.agentId, body, authentication)).toBeUndefined();

    expectProtocolError(
      () =>
        service.claimCommand(
          paired.agentId,
          body,
          requestAuthentication(paired.privateKey, tokens.access_token, path, body),
        ),
      'REPLAY_DETECTED',
    );
  });

  it('rejects authorization-code replay and refresh-token theft, revoking the family', () => {
    const service = new AgentService();
    const paired = pairAgent(service);
    const first = exchangeAuthorizationCode(service, paired);
    const replayedCodeBody: AgentTokenRequest = {
      grant_type: 'authorization_code',
      agent_id: paired.agentId,
      authorization_code: paired.authorizationCode,
    };
    expectProtocolError(
      () =>
        service.exchangeAgentToken(
          replayedCodeBody,
          proofAuthentication(paired.privateKey, replayedCodeBody),
        ),
      'REPLAY_DETECTED',
    );

    const rotated = rotateRefreshToken(service, paired, first.refresh_token);
    const stolenRefreshBody: AgentTokenRequest = {
      grant_type: 'refresh_token',
      agent_id: paired.agentId,
      refresh_token: first.refresh_token,
    };
    expectProtocolError(
      () =>
        service.exchangeAgentToken(
          stolenRefreshBody,
          proofAuthentication(paired.privateKey, stolenRefreshBody),
        ),
      'REPLAY_DETECTED',
    );

    const heartbeatBody = {
      agent_version: '1.0.0',
      status: 'online' as const,
      capabilities: [],
      authorization_version: rotated.authorization_version,
      observed_at: new Date().toISOString(),
    };
    const heartbeatPath = `/v1/agents/${paired.agentId}/heartbeat`;
    expectProtocolError(
      () =>
        service.heartbeat(
          paired.agentId,
          heartbeatBody,
          requestAuthentication(
            paired.privateKey,
            rotated.access_token,
            heartbeatPath,
            heartbeatBody,
          ),
        ),
      'TOKEN_REVOKED',
    );
  });

  it('rejects requests after explicit user revocation', () => {
    const service = new AgentService();
    const paired = pairAgent(service);
    const tokens = exchangeAuthorizationCode(service, paired);
    const revoked = service.revokeAgent(paired.principal, paired.agentId, idempotencyKey('revoke'));
    expect(revoked.status).toBe('revoked');
    expect(revoked.authorization_version).toBe(2);

    const body = { capabilities: ['preview'] as const, wait_seconds: 0 };
    const path = `/v1/agents/${paired.agentId}/commands:claim`;
    expectProtocolError(
      () =>
        service.claimCommand(
          paired.agentId,
          body,
          requestAuthentication(paired.privateKey, tokens.access_token, path, body),
        ),
      'TOKEN_REVOKED',
    );
  });

  it.each(['password', 'cookie', 'captcha', 'session_storage'])(
    'structurally rejects cloud credential field %s and never audits its value',
    (field) => {
      const service = new AgentService();
      const sentinel = `raw-secret-${randomUUID()}`;
      const principal = { user_id: randomUUID(), tenant_id: randomUUID() };

      expectProtocolError(
        () =>
          service.createPairingSession(
            principal,
            {
              requested_scopes: ALL_SCOPES,
              [field]: sentinel,
            },
            idempotencyKey('forbidden-credential'),
          ),
        'CREDENTIAL_DATA_FORBIDDEN',
      );
      expect(JSON.stringify(service.getAuditRecords())).not.toContain(sentinel);
      expect(service.getAuditRecords().at(-1)).toMatchObject({
        result: 'rejected',
        reason: 'CREDENTIAL_DATA_FORBIDDEN',
      });
    },
  );
});

describe('agent commands, receipts and heartbeat', () => {
  it('claims a reference-only command and records an idempotent receipt', () => {
    const clock = new FakeClock();
    const options: AgentServiceOptions = { clock };
    const service = new AgentService(options);
    const paired = pairAgent(service);
    const firstTokens = exchangeAuthorizationCode(service, paired);
    const taskId = randomUUID();
    const command = service.queueCommand({
      agent_id: paired.agentId,
      user_id: paired.principal.user_id,
      tenant_id: paired.principal.tenant_id,
      type: 'prepare_preview',
      idempotency_key: idempotencyKey('business-command'),
      expires_at: new Date(clock.now().getTime() + 120_000).toISOString(),
      resource: {
        type: 'task',
        id: taskId,
        version: 1,
      },
      payload: {
        task_id: taskId,
      },
    });
    expect(JSON.stringify(command)).not.toMatch(/password|cookie|captcha/i);

    const claimBody = { capabilities: ['preview'] as const, wait_seconds: 0 };
    const claimPath = `/v1/agents/${paired.agentId}/commands:claim`;
    const claimed = service.claimCommand(
      paired.agentId,
      claimBody,
      requestAuthentication(paired.privateKey, firstTokens.access_token, claimPath, claimBody),
    );
    expect(claimed?.command_id).toBe(command.command_id);

    const receiptTokens = rotateRefreshToken(service, paired, firstTokens.refresh_token);
    const receiptBody = {
      sequence: 1,
      status: 'accepted' as const,
      occurred_at: clock.now().toISOString(),
    };
    const receiptPath = `/v1/agents/${paired.agentId}/commands/${command.command_id}/receipts`;
    const receiptAuthentication = requestAuthentication(
      paired.privateKey,
      receiptTokens.access_token,
      receiptPath,
      receiptBody,
    );
    const firstReceipt = service.createCommandReceipt(
      paired.agentId,
      command.command_id,
      receiptBody,
      receiptAuthentication,
    );
    const retriedReceipt = service.createCommandReceipt(
      paired.agentId,
      command.command_id,
      receiptBody,
      receiptAuthentication,
    );
    expect(retriedReceipt).toEqual(firstReceipt);
  });

  it('records an idempotent heartbeat and marks stale agents offline', () => {
    const clock = new FakeClock();
    const service = new AgentService({ clock });
    const paired = pairAgent(service);
    const tokens = exchangeAuthorizationCode(service, paired);
    const body = {
      agent_version: '1.2.3',
      status: 'online' as const,
      capabilities: ['preview'] as const,
      authorization_version: 1,
      observed_at: clock.now().toISOString(),
    };
    const path = `/v1/agents/${paired.agentId}/heartbeat`;
    const requestNonce = nonce();
    const authentication = requestAuthentication(
      paired.privateKey,
      tokens.access_token,
      path,
      body,
      idempotencyKey('heartbeat'),
      requestNonce,
    );
    service.heartbeat(paired.agentId, body, authentication);
    service.heartbeat(paired.agentId, body, authentication);

    clock.advance(91_000);
    expect(service.sweepOfflineAgents()).toBe(1);
  });
});
