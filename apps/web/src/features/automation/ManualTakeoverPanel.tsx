'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { MANUAL_REASON_LABELS } from './policy';
import type {
  AutomationGateway,
  AutomationPermission,
  ManualTakeoverTask,
  TakeoverResolution,
} from './types';
import styles from './automation.module.css';

interface PendingResolution {
  readonly resolution: TakeoverResolution;
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly dangerous?: boolean;
}

export interface ManualTakeoverPanelProps {
  readonly gateway: AutomationGateway;
  readonly permission?: AutomationPermission;
}

const DEFAULT_PERMISSION: AutomationPermission = {
  canView: true,
  canEdit: true,
  canOperateAgent: true,
};

function assertAudit(receipt: {
  readonly eventId?: string;
  readonly outcome?: string;
}): asserts receipt is { readonly eventId: string; readonly outcome: 'succeeded' } {
  if (!receipt.eventId || receipt.outcome !== 'succeeded') {
    throw new Error('服务未返回审计回执，人工任务状态未在本页更新。');
  }
}

export function ManualTakeoverPanel({
  gateway,
  permission = DEFAULT_PERMISSION,
}: ManualTakeoverPanelProps) {
  const [tasks, setTasks] = useState<readonly ManualTakeoverTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [blockedNote, setBlockedNote] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [pending, setPending] = useState<PendingResolution | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await gateway.listTakeoverTasks();
      setTasks(loaded);
      setSelectedId((current) =>
        current && loaded.some((task) => task.id === current)
          ? current
          : (loaded[0]?.id ?? null),
      );
    } catch {
      setError('人工任务包加载失败。自动化继续保持暂停，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = tasks.find((task) => task.id === selectedId) ?? null;

  const resolve = async () => {
    if (!selected || !pending) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await gateway.resolveTakeoverTask(selected.id, pending.resolution);
      assertAudit(result.audit);
      setTasks((current) =>
        current.map((task) => (task.id === result.task.id ? result.task : task)),
      );
      setMessage(`任务状态已更新，审计记录 ${result.audit.eventId} 已写入。`);
      setPending(null);
      setBlockedNote('');
      setEvidenceReference('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '人工任务更新失败。');
    } finally {
      setBusy(false);
    }
  };

  if (!permission.canView) {
    return null;
  }

  return (
    <section className={styles.panel} aria-labelledby="takeover-title">
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Human takeover</p>
          <h2 className={styles.title} id="takeover-title">人工接管</h2>
          <p className={styles.subtitle}>
            自动化遇到未知、敏感或无法验证的步骤时立即暂停，不静默重试。
          </p>
        </div>
        <span className={`${styles.statusPill} ${gateway.kind === 'mock' ? styles.mockPill : ''}`}>
          {tasks.filter((task) => task.status === 'open' || task.status === 'still_blocked').length} 项待处理
        </span>
      </div>

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {message ? <div className={styles.success} role="status">{message}</div> : null}

      {loading ? (
        <>
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </>
      ) : tasks.length === 0 ? (
        <div className={styles.section}>
          <p className={styles.empty}>当前没有人工接管任务，可返回申请看板。</p>
        </div>
      ) : (
        <div className={styles.takeoverGrid}>
          <nav aria-label="人工任务列表" className={styles.taskList}>
            {tasks.map((task) => (
              <button
                aria-current={task.id === selectedId}
                className={styles.taskButton}
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                type="button"
              >
                <strong>{task.company}</strong>
                <span>{task.jobTitle}</span>
                <span>{MANUAL_REASON_LABELS[task.reason]} · {task.status}</span>
              </button>
            ))}
          </nav>

          {selected ? (
            <article className={styles.taskDetail}>
              <div className={styles.detailHeader}>
                <div>
                  <h3>{selected.jobTitle}</h3>
                  <p>{selected.company} · 预计 {selected.estimatedMinutes} 分钟</p>
                </div>
                <a
                  className={styles.secondaryButton}
                  href={selected.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  打开本地任务页面
                </a>
              </div>

              {selected.mayHaveSubmitted || selected.reason === 'submission_result_uncertain' ? (
                <div className={styles.riskBanner} role="alert">
                  <strong>不要重复提交。</strong> 当前无法确认招聘网站是否已收到申请，必须先核对结果。
                </div>
              ) : null}

              <div className={styles.detailGrid}>
                <div className={styles.detailCard}>
                  <span>暂停原因</span>
                  <strong>{MANUAL_REASON_LABELS[selected.reason]}</strong>
                </div>
                <div className={styles.detailCard}>
                  <span>发生步骤</span>
                  <strong>{selected.occurredAtStep}</strong>
                </div>
                <div className={styles.detailCard}>
                  <span>已完成</span>
                  <strong>{selected.completedActions.length} 项动作</strong>
                </div>
                <div className={styles.detailCard}>
                  <span>尚未完成</span>
                  <strong>{selected.outstandingActions.length} 项动作</strong>
                </div>
              </div>

              <span className={styles.fieldLabel}>请在本地完成</span>
              <ol className={styles.checkList}>
                {selected.instructions.map((instruction) => (
                  <li key={instruction}>{instruction}</li>
                ))}
              </ol>

              {permission.canOperateAgent &&
              (selected.status === 'open' || selected.status === 'still_blocked') ? (
                <>
                  <div className={styles.limitGrid}>
                    <div className={styles.field}>
                      <label htmlFor={`evidence-${selected.id}`}>确认编号/证据引用（可选）</label>
                      <input
                        className={styles.input}
                        id={`evidence-${selected.id}`}
                        onChange={(event) => setEvidenceReference(event.target.value)}
                        placeholder="不填写则进入待确认"
                        value={evidenceReference}
                      />
                    </div>
                    <div className={styles.field}>
                      <label htmlFor={`blocked-${selected.id}`}>仍被阻塞的说明</label>
                      <input
                        className={styles.input}
                        id={`blocked-${selected.id}`}
                        onChange={(event) => setBlockedNote(event.target.value)}
                        placeholder="不包含密码、验证码或敏感回答"
                        value={blockedNote}
                      />
                    </div>
                  </div>
                  <div className={styles.actionRow}>
                    <button
                      className={styles.secondaryButton}
                      disabled={busy || blockedNote.trim().length === 0}
                      onClick={() =>
                        setPending({
                          title: '保持人工暂停？',
                          description: '原因会更新，但不会重置截止时间或丢失已完成步骤。',
                          label: '确认仍被阻塞',
                          resolution: { kind: 'still_blocked', note: blockedNote.trim() },
                        })
                      }
                      type="button"
                    >
                      仍被阻塞
                    </button>
                    <button
                      className={styles.secondaryButton}
                      disabled={busy || selected.mayHaveSubmitted}
                      onClick={() =>
                        setPending({
                          title: '交还代理重新检查？',
                          description:
                            '代理会重新识别页面并执行预检，不会从旧步骤盲目续跑。提交结果不确定时此操作不可用。',
                          label: '确认交还代理',
                          resolution: { kind: 'return_to_agent' },
                        })
                      }
                      type="button"
                    >
                      交还代理检查
                    </button>
                    <button
                      className={styles.dangerButton}
                      disabled={busy}
                      onClick={() =>
                        setPending({
                          title: '放弃这项人工任务？',
                          description: '放弃不会删除任务包或历史记录，申请不会被标记为成功。',
                          label: '确认放弃',
                          dangerous: true,
                          resolution: { kind: 'abandon' },
                        })
                      }
                      type="button"
                    >
                      放弃
                    </button>
                    <button
                      className={styles.primaryButton}
                      disabled={busy}
                      onClick={() =>
                        setPending({
                          title: '标记人工步骤已完成？',
                          description: evidenceReference.trim()
                            ? '系统将校验提供的证据；证据可信后才会更新最终结果。'
                            : '未提供证据时只会进入“待确认”，不会直接标记为已提交。',
                          label: '确认已完成',
                          resolution: {
                            kind: 'completed',
                            evidenceReference: evidenceReference.trim() || undefined,
                          },
                        })
                      }
                      type="button"
                    >
                      已完成
                    </button>
                  </div>
                </>
              ) : (
                <p className={styles.notice}>
                  {permission.canOperateAgent
                    ? `此任务当前状态为 ${selected.status}，不可重复处理。`
                    : '你只有查看权限，不能领取或恢复人工任务。'}
                </p>
              )}
            </article>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        busy={busy}
        confirmLabel={pending?.label ?? '确认'}
        dangerous={pending?.dangerous}
        description={pending?.description ?? ''}
        onCancel={() => setPending(null)}
        onConfirm={() => void resolve()}
        open={pending !== null}
        title={pending?.title ?? ''}
      />
    </section>
  );
}
