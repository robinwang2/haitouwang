import type { AuditReceipt } from '../automation/types';
import type {
  AgentConnection,
  ConnectionGateway,
  ConnectionSnapshot,
  PairingSession,
} from './types';

const EMPTY_SOURCES: ConnectionSnapshot['sources'] = [
  {
    kind: 'greenhouse',
    name: 'Greenhouse',
    status: 'online',
    lastSuccessAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    affectedTaskCount: 0,
  },
  {
    kind: 'lever',
    name: 'Lever',
    status: 'online',
    lastSuccessAt: new Date(Date.now() - 24 * 60_000).toISOString(),
    affectedTaskCount: 0,
  },
  {
    kind: 'company_careers',
    name: '公司 Careers',
    status: 'unknown',
    lastSuccessAt: null,
    affectedTaskCount: 0,
  },
  {
    kind: 'manual_url',
    name: '手动 URL',
    status: 'online',
    lastSuccessAt: new Date(Date.now() - 7 * 60_000).toISOString(),
    affectedTaskCount: 0,
  },
];

function mockId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function audit(action: string, changedFields: readonly string[]): AuditReceipt {
  return {
    eventId: mockId('audit'),
    action,
    occurredAt: new Date().toISOString(),
    outcome: 'succeeded',
    changedFields,
  };
}

export function createConnectionsMockGateway(
  initialAgent: AgentConnection | null = null,
): ConnectionGateway {
  let snapshot: ConnectionSnapshot = {
    agent: initialAgent,
    sources: EMPTY_SOURCES,
    loadedAt: new Date().toISOString(),
  };
  const sessions = new Map<string, { value: PairingSession; refreshCount: number }>();

  return {
    kind: 'mock',

    async getSnapshot() {
      return snapshot;
    },

    async createPairingSession() {
      const id = mockId('pairing');
      const session: PairingSession = {
        id,
        pairingUri: `haitouwang://pair?session=${encodeURIComponent(id)}&secret=mock-one-time-material`,
        displayCode: 'HTW2-7K9M',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        status: 'issued',
      };
      sessions.set(id, { value: session, refreshCount: 0 });
      return session;
    },

    async refreshPairingSession(sessionId) {
      const record = sessions.get(sessionId);
      if (!record) {
        throw new Error('配对会话不存在或已经失效。');
      }

      if (Date.parse(record.value.expiresAt) <= Date.now()) {
        record.value = { ...record.value, pairingUri: '', status: 'expired' };
        return record.value;
      }

      record.refreshCount += 1;
      if (record.refreshCount >= 1 && record.value.status === 'issued') {
        record.value = {
          ...record.value,
          status: 'claimed',
          deviceName: '本机 · Chrome',
          publicKeyThumbprint: 'wPqWn-Z2a7vN4jB8xE6mF1sT9kL3cR5uH0dG2yQ7iXo',
        };
      }
      return record.value;
    },

    async cancelPairingSession(sessionId) {
      const record = sessions.get(sessionId);
      if (record) {
        record.value = { ...record.value, pairingUri: '', status: 'revoked' };
      }
    },

    async confirmPairingSession(sessionId, confirmation) {
      const record = sessions.get(sessionId);
      if (
        !record ||
        record.value.status !== 'claimed' ||
        record.value.displayCode !== confirmation.displayCode ||
        record.value.publicKeyThumbprint !== confirmation.publicKeyThumbprint ||
        confirmation.approved !== true
      ) {
        throw new Error('设备信息已变化或配对材料无效，请重新配对。');
      }

      const now = new Date().toISOString();
      const agent: AgentConnection = {
        id: mockId('agent'),
        deviceName: record.value.deviceName ?? '本地代理',
        publicKeyThumbprint: record.value.publicKeyThumbprint,
        status: 'online',
        scopes: [
          'agent:commands:claim',
          'agent:receipts:write',
          'agent:heartbeat:write',
        ],
        pairedAt: now,
        lastSeenAt: now,
        authorizationExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        affectedTaskCount: 0,
      };
      record.value = { ...record.value, pairingUri: '', status: 'confirmed' };
      snapshot = { ...snapshot, agent, loadedAt: now };

      return {
        agent,
        snapshot,
        audit: audit('agent.pairing_confirmed', ['agent']),
      };
    },

    async revokeAgent(agentId, confirmation) {
      if (
        !snapshot.agent ||
        snapshot.agent.id !== agentId ||
        confirmation.affectedTasksAcknowledged !== true ||
        Number.isNaN(Date.parse(confirmation.confirmedAt))
      ) {
        throw new Error('撤销确认无效，未执行任何操作。');
      }

      snapshot = {
        ...snapshot,
        agent: { ...snapshot.agent, status: 'revoked' },
        loadedAt: new Date().toISOString(),
      };
      return {
        snapshot,
        audit: audit('agent.authorization_revoked', ['status', 'authorization_version']),
      };
    },
  };
}
