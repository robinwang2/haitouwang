import type { AuditReceipt } from '../automation/types';

export type AgentContractStatus = 'unpaired' | 'pairing' | 'online' | 'offline' | 'revoked';

export type ConnectionDisplayStatus =
  | AgentContractStatus
  | 'authorization_expiring'
  | 'expired'
  | 'paused'
  | 'error'
  | 'unknown';

export type AgentScope =
  | 'agent:commands:claim'
  | 'agent:receipts:write'
  | 'agent:heartbeat:write';

export interface AgentConnection {
  readonly id: string;
  readonly deviceName: string;
  readonly publicKeyThumbprint: string;
  readonly status: ConnectionDisplayStatus;
  readonly scopes: readonly AgentScope[];
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  readonly authorizationExpiresAt: string | null;
  readonly affectedTaskCount: number;
  readonly pauseReason?: string;
}

export type JobSourceKind = 'greenhouse' | 'lever' | 'company_careers' | 'manual_url';

export interface JobSourceConnection {
  readonly kind: JobSourceKind;
  readonly name: string;
  readonly status: 'online' | 'offline' | 'paused' | 'error' | 'unknown';
  readonly lastSuccessAt: string | null;
  readonly pauseReason?: string;
  readonly affectedTaskCount: number;
}

export interface ConnectionSnapshot {
  readonly agent: AgentConnection | null;
  readonly sources: readonly JobSourceConnection[];
  readonly loadedAt: string;
}

export interface ConnectionPermission {
  readonly canView: boolean;
  readonly canManage: boolean;
  readonly canOperateAgent: boolean;
}

export type PairingStatus = 'issued' | 'claimed' | 'confirmed' | 'expired' | 'revoked';

export interface PairingSession {
  readonly id: string;
  /**
   * The URI is one-time material and must never be logged or retained after the
   * session ends.
   */
  readonly pairingUri: string;
  readonly displayCode: string;
  readonly expiresAt: string;
  readonly status: PairingStatus;
  readonly deviceName?: string;
  readonly publicKeyThumbprint?: string;
}

export interface PairingConfirmation {
  readonly displayCode: string;
  readonly publicKeyThumbprint: string;
  readonly approved: true;
}

export interface ConnectionMutationResult {
  readonly snapshot: ConnectionSnapshot;
  readonly audit: AuditReceipt;
}

export interface PairingConfirmationResult extends ConnectionMutationResult {
  readonly agent: AgentConnection;
}

export interface ConnectionGateway {
  readonly kind: 'production' | 'mock';
  getSnapshot(signal?: AbortSignal): Promise<ConnectionSnapshot>;
  createPairingSession(signal?: AbortSignal): Promise<PairingSession>;
  refreshPairingSession(sessionId: string, signal?: AbortSignal): Promise<PairingSession>;
  cancelPairingSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  confirmPairingSession(
    sessionId: string,
    confirmation: PairingConfirmation,
    signal?: AbortSignal,
  ): Promise<PairingConfirmationResult>;
  revokeAgent(
    agentId: string,
    confirmation: {
      readonly affectedTasksAcknowledged: true;
      readonly confirmedAt: string;
    },
    signal?: AbortSignal,
  ): Promise<ConnectionMutationResult>;
}
