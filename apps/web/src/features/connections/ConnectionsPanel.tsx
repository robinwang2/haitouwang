'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../automation/ConfirmDialog';
import type {
  AgentConnection,
  ConnectionDisplayStatus,
  ConnectionGateway,
  ConnectionPermission,
  ConnectionSnapshot,
  JobSourceConnection,
  PairingSession,
} from './types';
import styles from './connections.module.css';

export interface ConnectionsPanelProps {
  readonly gateway: ConnectionGateway;
  readonly permission?: ConnectionPermission;
}

const DEFAULT_PERMISSION: ConnectionPermission = {
  canView: true,
  canManage: true,
  canOperateAgent: true,
};

const STATUS_LABEL: Readonly<Record<ConnectionDisplayStatus, string>> = {
  unpaired: '未连接',
  pairing: '配对中',
  online: '在线',
  offline: '离线',
  revoked: '已撤销',
  authorization_expiring: '授权即将到期',
  expired: '已过期',
  paused: '已暂停',
  error: '错误',
  unknown: '未知',
};

function statusClass(status: ConnectionDisplayStatus | JobSourceConnection['status']): string {
  if (status === 'online') {
    return `${styles.status} ${styles.statusGood}`;
  }
  if (status === 'offline' || status === 'paused' || status === 'authorization_expiring') {
    return `${styles.status} ${styles.statusWarn}`;
  }
  if (status === 'error' || status === 'expired' || status === 'revoked') {
    return `${styles.status} ${styles.statusBad}`;
  }
  return `${styles.status} ${styles.statusNeutral}`;
}

function formatTime(value: string | null): string {
  if (!value) {
    return '尚无记录';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function redactThumbprint(value: string): string {
  if (value.length < 14) {
    return value;
  }
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function assertAudit(receipt: {
  readonly eventId?: string;
  readonly outcome?: string;
}): asserts receipt is { readonly eventId: string; readonly outcome: 'succeeded' } {
  if (!receipt.eventId || receipt.outcome !== 'succeeded') {
    throw new Error('服务未返回审计回执，请刷新确认最终状态后再操作。');
  }
}

function AgentDetails({
  agent,
  canManage,
  busy,
  onRevoke,
}: {
  readonly agent: AgentConnection;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}) {
  return (
    <div className={styles.agentCard}>
      <div className={styles.agentHeader}>
        <div className={styles.agentIdentity}>
          <span aria-hidden="true" className={styles.agentIcon}>
            ⌁
          </span>
          <div>
            <h3>{agent.deviceName}</h3>
            <p>本地浏览器代理</p>
          </div>
        </div>
        <span className={statusClass(agent.status)}>{STATUS_LABEL[agent.status]}</span>
      </div>
      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <span>最近心跳</span>
          <strong>{formatTime(agent.lastSeenAt)}</strong>
        </div>
        <div className={styles.metaItem}>
          <span>配对时间</span>
          <strong>{formatTime(agent.pairedAt)}</strong>
        </div>
        <div className={styles.metaItem}>
          <span>授权到期</span>
          <strong>{formatTime(agent.authorizationExpiresAt)}</strong>
        </div>
        <div className={styles.metaItem}>
          <span>设备公钥指纹</span>
          <code title={agent.publicKeyThumbprint}>
            {redactThumbprint(agent.publicKeyThumbprint)}
          </code>
        </div>
      </div>
      {agent.pauseReason ? (
        <p className={styles.notice}>
          暂停原因：{agent.pauseReason}。满足恢复条件前不会领取新任务。
        </p>
      ) : null}
      <div className={styles.scopeList} aria-label="已授权能力">
        {agent.scopes.map((scope) => (
          <span className={styles.scope} key={scope}>
            {scope}
          </span>
        ))}
      </div>
      {canManage && agent.status !== 'revoked' ? (
        <div className={styles.agentActions}>
          <button className={styles.dangerButton} disabled={busy} onClick={onRevoke} type="button">
            撤销代理授权
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ConnectionsPanel({
  gateway,
  permission = DEFAULT_PERMISSION,
}: ConnectionsPanelProps) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [pairingBoundaryRead, setPairingBoundaryRead] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const closePairingRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await gateway.getSnapshot());
    } catch {
      setError('连接状态读取失败。所有未知连接均按不可用处理，不会启动新任务。');
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pairing) {
      window.setTimeout(() => closePairingRef.current?.focus(), 0);
    }
  }, [pairing]);

  const startPairing = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setPairing(await gateway.createPairingSession());
      setPairingBoundaryRead(false);
    } catch {
      setError('一次性配对码创建失败，请安全重试。');
    } finally {
      setBusy(false);
    }
  };

  const refreshPairing = async () => {
    if (!pairing) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPairing(await gateway.refreshPairingSession(pairing.id));
    } catch {
      setError('无法确认本地代理状态。旧码不会被自动复用，请刷新后重试。');
    } finally {
      setBusy(false);
    }
  };

  const closePairing = async () => {
    if (pairing) {
      await gateway.cancelPairingSession(pairing.id);
    }
    setPairing(null);
    setPairingBoundaryRead(false);
  };

  const confirmPairing = async () => {
    if (
      !pairing ||
      pairing.status !== 'claimed' ||
      !pairing.publicKeyThumbprint ||
      !pairingBoundaryRead
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.confirmPairingSession(pairing.id, {
        displayCode: pairing.displayCode,
        publicKeyThumbprint: pairing.publicKeyThumbprint,
        approved: true,
      });
      assertAudit(result.audit);
      setSnapshot(result.snapshot);
      setPairing(null);
      setMessage(`设备已配对，审计记录 ${result.audit.eventId} 已写入。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '确认配对失败。');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!snapshot?.agent) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.revokeAgent(snapshot.agent.id, {
        affectedTasksAcknowledged: true,
        confirmedAt: new Date().toISOString(),
      });
      assertAudit(result.audit);
      setSnapshot(result.snapshot);
      setMessage(`代理授权已撤销，审计记录 ${result.audit.eventId} 已写入。`);
      setRevokeOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : '撤销结果未知。已禁止重复操作，请刷新查询最终状态。',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!permission.canView) {
    return (
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2 className={styles.title}>连接</h2>
        </div>
        <p className={styles.notice}>你没有查看连接状态的权限。</p>
        <div className={styles.sourceSection} />
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="connections-title">
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Connections</p>
          <h2 className={styles.title} id="connections-title">
            连接总览
          </h2>
          <p className={styles.subtitle}>
            本地代理只接收脱敏命令；招聘网站凭证、Cookie 与验证码始终留在你的设备上。
          </p>
        </div>
        {permission.canManage && !snapshot?.agent ? (
          <button
            className={styles.primaryButton}
            disabled={busy || loading}
            onClick={() => void startPairing()}
            type="button"
          >
            连接本地代理
          </button>
        ) : null}
      </div>

      {error ? (
        <div className={styles.error} role="alert">
          {error}{' '}
          <button className={styles.textButton} onClick={() => void load()} type="button">
            刷新状态
          </button>
        </div>
      ) : null}
      {message ? (
        <div className={styles.success} role="status">
          {message}
        </div>
      ) : null}

      {loading ? (
        <>
          <div aria-label="正在读取本地代理安全状态" className={styles.skeleton} />
          <div className={styles.skeleton} />
        </>
      ) : (
        <>
          <div className={styles.agentArea}>
            {snapshot?.agent ? (
              <AgentDetails
                agent={snapshot.agent}
                busy={busy}
                canManage={permission.canManage}
                onRevoke={() => setRevokeOpen(true)}
              />
            ) : (
              <div className={styles.emptyAgent}>
                <h3>尚未连接本地代理</h3>
                <p>
                  安装并启动本地代理，然后使用 10
                  分钟内有效的一次性链接完成配对。没有代理时仍可查看职位与材料。
                </p>
                {permission.canManage ? (
                  <button
                    className={styles.primaryButton}
                    disabled={busy}
                    onClick={() => void startPairing()}
                    type="button"
                  >
                    开始安全配对
                  </button>
                ) : (
                  <p className={styles.notice}>你只有查看权限，不能创建配对码。</p>
                )}
              </div>
            )}
            <aside className={styles.securityCard}>
              <h3>本地与云端的边界</h3>
              <ul>
                <li>密码、Cookie、验证码和页面存储不上传。</li>
                <li>设备私钥不可导出，云端只保存公钥指纹。</li>
                <li>访问令牌最长 5 分钟，并绑定当前设备。</li>
                <li>撤销后不再领取新任务；已撤销设备必须重新配对。</li>
              </ul>
            </aside>
          </div>

          <div className={styles.sourceSection}>
            <div className={styles.sectionHeading}>
              <h3>职位来源</h3>
              <span>来源不可用不会隐藏已有职位；手动 URL 始终可作为降级入口</span>
            </div>
            {snapshot && snapshot.sources.length > 0 ? (
              <div className={styles.sourceGrid}>
                {snapshot.sources.map((source) => (
                  <article className={styles.sourceCard} key={source.kind}>
                    <div className={styles.sourceCardHeader}>
                      <h4>{source.name}</h4>
                      <span className={statusClass(source.status)}>
                        {STATUS_LABEL[source.status]}
                      </span>
                    </div>
                    <p>
                      {source.pauseReason
                        ? `暂停：${source.pauseReason}`
                        : `最近成功：${formatTime(source.lastSuccessAt)}`}
                    </p>
                  </article>
                ))}
              </div>
            ) : (
              <p className={styles.notice}>
                暂无可用职位来源。你仍可通过手动 URL 导入职位，已有记录不会受影响。
              </p>
            )}
          </div>
        </>
      )}

      {pairing ? (
        <div className={styles.pairingBackdrop} role="presentation">
          <section
            aria-labelledby="pairing-title"
            aria-modal="true"
            className={styles.pairingDialog}
            role="dialog"
          >
            <h2 id="pairing-title">连接本地代理</h2>
            <p>一次性材料仅用于当前配对。不要把链接发送给他人，也不要粘贴到日志或工单。</p>

            <ol className={styles.steps}>
              <li>在本机启动海投王本地代理。</li>
              <li>复制安全链接到本地代理，并在本地确认账户与请求能力。</li>
              <li>核对设备名称、短码和公钥指纹，再在此页显式批准。</li>
            </ol>

            <div className={styles.codeBox}>
              <span>人工核对短码</span>
              <strong>{pairing.displayCode}</strong>
              <p>有效期至 {formatTime(pairing.expiresAt)} · 使用一次后立即失效</p>
            </div>

            {pairing.status === 'issued' ? (
              <>
                <div className={styles.actionRow}>
                  <button
                    className={styles.secondaryButton}
                    disabled={busy}
                    onClick={() => void navigator.clipboard.writeText(pairing.pairingUri)}
                    type="button"
                  >
                    复制一次性安全链接
                  </button>
                  <button
                    className={styles.primaryButton}
                    disabled={busy}
                    onClick={() => void refreshPairing()}
                    type="button"
                  >
                    {busy ? '正在检查…' : '我已在本地确认，检查状态'}
                  </button>
                </div>
              </>
            ) : null}

            {pairing.status === 'claimed' ? (
              <div className={styles.deviceClaim}>
                <h3>本地设备请求已到达，请核对</h3>
                <dl>
                  <dt>设备</dt>
                  <dd>{pairing.deviceName}</dd>
                  <dt>短码</dt>
                  <dd>{pairing.displayCode}</dd>
                  <dt>公钥指纹</dt>
                  <dd>{pairing.publicKeyThumbprint}</dd>
                </dl>
                <label className={styles.notice}>
                  <input
                    checked={pairingBoundaryRead}
                    onChange={(event) => setPairingBoundaryRead(event.target.checked)}
                    type="checkbox"
                  />{' '}
                  我确认这是我的设备，并理解配对会授权代理领取任务、写回执与发送心跳；操作将写入审计。
                </label>
              </div>
            ) : null}

            {pairing.status === 'expired' || pairing.status === 'revoked' ? (
              <div className={styles.error} role="alert">
                此配对材料已失效，不能继续使用。关闭后可创建新的会话。
              </div>
            ) : null}

            <div className={styles.actionRow}>
              <button
                className={styles.secondaryButton}
                disabled={busy}
                onClick={() => void closePairing()}
                ref={closePairingRef}
                type="button"
              >
                取消配对
              </button>
              {pairing.status === 'claimed' ? (
                <button
                  className={styles.primaryButton}
                  disabled={!pairingBoundaryRead || busy}
                  onClick={() => void confirmPairing()}
                  type="button"
                >
                  {busy ? '正在绑定…' : '确认绑定此设备'}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        busy={busy}
        confirmLabel="确认撤销授权"
        dangerous
        description={`撤销后代理不再领取新任务，并取消排队工作。当前受影响任务 ${
          snapshot?.agent?.affectedTaskCount ?? 0
        } 项；目标网站的本地浏览器数据不会被云端删除。`}
        onCancel={() => setRevokeOpen(false)}
        onConfirm={() => void revoke()}
        open={revokeOpen}
        title="撤销本地代理授权？"
      />
    </section>
  );
}
