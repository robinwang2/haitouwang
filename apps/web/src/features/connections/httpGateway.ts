import type {
  AgentConnection,
  AgentContractStatus,
  AgentScope,
  ConnectionGateway,
  ConnectionSnapshot,
  PairingSession,
} from './types';
import type { AuditReceipt } from '../automation/types';

interface ApiAgent {
  readonly id: string;
  readonly device_name: string;
  readonly public_key_thumbprint: string;
  readonly status: AgentContractStatus;
  readonly scopes: readonly AgentScope[];
  readonly last_seen_at?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AgentPage {
  readonly items: readonly ApiAgent[];
}

interface PairingCreated {
  readonly pairing_session_id: string;
  readonly pairing_uri: string;
  readonly display_code: string;
  readonly expires_at: string;
}

interface ApiAuditEvent {
  readonly event_id: string;
  readonly occurred_at: string;
  readonly action: string;
  readonly outcome: 'succeeded' | 'rejected' | 'failed' | 'manual_intervention';
  readonly correlation_id: string;
  readonly changed_fields: readonly string[];
}

interface ApiAuditPage {
  readonly items: readonly ApiAuditEvent[];
}

export interface ConnectionHttpGatewayOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly getCorrelationId?: () => string;
  /**
   * The current OpenAPI has no authenticated read endpoint for a pairing
   * session. The host must bridge its realtime/polling transport here.
   */
  readonly refreshPairingSession: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<PairingSession>;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`连接服务请求失败（HTTP ${response.status}）。`);
  }
  return (await response.json()) as T;
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

function toAgent(agent: ApiAgent): AgentConnection {
  return {
    id: agent.id,
    deviceName: agent.device_name,
    publicKeyThumbprint: agent.public_key_thumbprint,
    status: agent.status,
    scopes: agent.scopes,
    pairedAt: agent.created_at,
    lastSeenAt: agent.last_seen_at ?? null,
    authorizationExpiresAt: null,
    affectedTaskCount: 0,
  };
}

/**
 * Adapter for the checked-in Agent OpenAPI contract. Automation settings are
 * deliberately not included because no backend contract exists for them yet.
 */
export function createConnectionHttpGateway(
  options: ConnectionHttpGatewayOptions,
): ConnectionGateway {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
  let lastSnapshot: ConnectionSnapshot = {
    agent: null,
    sources: [],
    loadedAt: new Date(0).toISOString(),
  };

  const nextCorrelationId = () => options.getCorrelationId?.() ?? crypto.randomUUID();

  const readAuditReceipt = async (
    resourceId: string,
    action: string,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<AuditReceipt> => {
    const response = await fetcher(
      `${baseUrl}/v1/audit-events?resource_id=${encodeURIComponent(resourceId)}&page_size=20`,
      { credentials: 'include', signal },
    );
    const page = await readJson<ApiAuditPage>(response);
    const event = page.items.find(
      (candidate) =>
        candidate.action === action &&
        candidate.correlation_id === correlationId &&
        candidate.outcome === 'succeeded',
    );
    if (!event) {
      throw new Error('操作已返回，但尚未验证到对应审计记录。请刷新最终状态，不要重复操作。');
    }
    return {
      eventId: event.event_id,
      action: event.action,
      occurredAt: event.occurred_at,
      outcome: 'succeeded',
      changedFields: event.changed_fields,
    };
  };

  return {
    kind: 'production',

    async getSnapshot(signal) {
      const response = await fetcher(`${baseUrl}/v1/agents?page_size=20`, {
        credentials: 'include',
        signal,
      });
      const page = await readJson<AgentPage>(response);
      const active =
        page.items.find((agent) => agent.status !== 'revoked') ?? page.items[0] ?? null;
      lastSnapshot = {
        agent: active ? toAgent(active) : null,
        sources: [],
        loadedAt: new Date().toISOString(),
      };
      return lastSnapshot;
    },

    async createPairingSession(signal) {
      const correlationId = nextCorrelationId();
      const response = await fetcher(`${baseUrl}/v1/agent-pairing-sessions`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey(),
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify({
          requested_scopes: [
            'agent:commands:claim',
            'agent:receipts:write',
            'agent:heartbeat:write',
          ],
        }),
        signal,
      });
      const created = await readJson<PairingCreated>(response);
      return {
        id: created.pairing_session_id,
        pairingUri: created.pairing_uri,
        displayCode: created.display_code,
        expiresAt: created.expires_at,
        status: 'issued',
      };
    },

    refreshPairingSession: options.refreshPairingSession,

    async cancelPairingSession() {
      // The checked-in OpenAPI exposes no cancellation operation. Discarding
      // the one-time material locally is safe; server expiry remains authoritative.
    },

    async confirmPairingSession(sessionId, confirmation, signal) {
      const correlationId = nextCorrelationId();
      const response = await fetcher(
        `${baseUrl}/v1/agent-pairing-sessions/${encodeURIComponent(sessionId)}:confirm`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey(),
            'X-Correlation-Id': correlationId,
          },
          body: JSON.stringify({
            display_code: confirmation.displayCode,
            public_key_thumbprint: confirmation.publicKeyThumbprint,
            approved: true,
          }),
          signal,
        },
      );
      const body = await readJson<{ readonly agent: ApiAgent }>(response);
      const agent = toAgent(body.agent);
      const audit = await readAuditReceipt(
        agent.id,
        'agent.pairing_confirmed',
        correlationId,
        signal,
      );
      lastSnapshot = { ...lastSnapshot, agent, loadedAt: new Date().toISOString() };
      return {
        agent,
        snapshot: lastSnapshot,
        audit,
      };
    },

    async revokeAgent(agentId, confirmation, signal) {
      if (confirmation.affectedTasksAcknowledged !== true) {
        throw new Error('撤销前必须确认受影响任务。');
      }
      const correlationId = nextCorrelationId();
      const response = await fetcher(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}:revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Idempotency-Key': idempotencyKey(),
          'X-Correlation-Id': correlationId,
        },
        signal,
      });
      const body = await readJson<ApiAgent>(response);
      const audit = await readAuditReceipt(
        agentId,
        'agent.authorization_revoked',
        correlationId,
        signal,
      );
      lastSnapshot = {
        ...lastSnapshot,
        agent: toAgent(body),
        loadedAt: new Date().toISOString(),
      };
      return {
        snapshot: lastSnapshot,
        audit,
      };
    },
  };
}
