'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import {
  CAPABILITY_CONTENT,
  CAPABILITY_ORDER,
  createSafeAutomationSnapshot,
  effectiveApplicationLimit,
  enforceSafeSnapshot,
  isMutableCapability,
  validateLimits,
} from './policy';
import type {
  AutomationChange,
  AutomationGateway,
  AutomationLimits,
  AutomationPermission,
  AutomationSnapshot,
} from './types';
import styles from './automation.module.css';

interface PendingChange {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly dangerous?: boolean;
  readonly change: AutomationChange;
}

export interface AutomationControlPanelProps {
  readonly gateway: AutomationGateway;
  readonly permission?: AutomationPermission;
}

const DEFAULT_PERMISSION: AutomationPermission = {
  canView: true,
  canEdit: true,
  canOperateAgent: true,
};

function optionalInteger(value: string): number | null {
  if (value.trim() === '') {
    return null;
  }
  return Number(value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function assertAuditResult(result: {
  readonly audit?: { readonly eventId?: string; readonly outcome?: string };
}): void {
  if (!result.audit?.eventId || result.audit.outcome !== 'succeeded') {
    throw new Error('服务未返回成功的审计回执，界面保持原状态。');
  }
}

export function AutomationControlPanel({
  gateway,
  permission = DEFAULT_PERMISSION,
}: AutomationControlPanelProps) {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>(() =>
    createSafeAutomationSnapshot(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [dailyLimit, setDailyLimit] = useState('');
  const [companyLimit, setCompanyLimit] = useState('');
  const [concurrentTasks, setConcurrentTasks] = useState('1');

  const syncLimitDraft = useCallback((limits: AutomationLimits) => {
    setDailyLimit(limits.dailyApplications?.toString() ?? '');
    setCompanyLimit(limits.perCompanyApplications?.toString() ?? '');
    setConcurrentTasks(limits.concurrentTasks.toString());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = enforceSafeSnapshot(await gateway.getSnapshot());
      setSnapshot(loaded);
      syncLimitDraft(loaded.limits);
    } catch {
      const safe = createSafeAutomationSnapshot();
      setSnapshot(safe);
      syncLimitDraft(safe.limits);
      setError('无法读取自动化设置。为安全起见，所有能力按关闭/未知处理。');
    } finally {
      setLoading(false);
    }
  }, [gateway, syncLimitDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  const limitDraft = useMemo<AutomationLimits>(
    () => ({
      dailyApplications: optionalInteger(dailyLimit),
      perCompanyApplications: optionalInteger(companyLimit),
      concurrentTasks: Number(concurrentTasks),
    }),
    [companyLimit, concurrentTasks, dailyLimit],
  );
  const limitErrors = useMemo(() => validateLimits(limitDraft), [limitDraft]);
  const canChange = permission.canEdit && !loading && !error && !busy;

  const applyPendingChange = async () => {
    if (!pending) {
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await gateway.applyConfirmedChange({
        expectedRevision: snapshot.revision,
        change: pending.change,
        confirmation: {
          impactAcknowledged: true,
          confirmedAt: new Date().toISOString(),
        },
      });
      assertAuditResult(result);
      const next = enforceSafeSnapshot(result.snapshot);
      setSnapshot(next);
      syncLimitDraft(next.limits);
      setSuccess(`更改已生效，审计记录 ${result.audit.eventId} 已写入。`);
      setPending(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更改失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  if (!permission.canView) {
    return (
      <section className={styles.panel} aria-labelledby="automation-title">
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>Automation</p>
            <h2 className={styles.title} id="automation-title">
              自动化规则
            </h2>
          </div>
        </div>
        <p className={styles.notice}>你没有查看自动化设置的权限。</p>
        <div className={styles.section} />
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="automation-title">
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Automation guardrails</p>
          <h2 className={styles.title} id="automation-title">
            自动化规则与限额
          </h2>
          <p className={styles.subtitle}>
            能力按最小权限独立控制。任何开关或限额变更均先确认影响，再由服务写入审计。
          </p>
        </div>
        <span className={`${styles.statusPill} ${gateway.kind === 'mock' ? styles.mockPill : ''}`}>
          {gateway.kind === 'mock' ? 'Mock · 非生产数据' : '策略已保护'}
        </span>
      </div>

      {loading ? (
        <>
          <div aria-label="正在读取自动化安全状态" className={styles.skeleton} />
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </>
      ) : (
        <>
          {error ? (
            <div className={styles.error} role="alert">
              {error}{' '}
              <button className={styles.textButton} onClick={() => void load()} type="button">
                重新读取
              </button>
            </div>
          ) : null}
          {success ? (
            <div className={styles.success} role="status">
              {success}
            </div>
          ) : null}

          {snapshot.pause ? (
            <div className={styles.pauseBanner}>
              <div>
                <strong>自动化已暂停 · {snapshot.pause.scope}</strong>
                {snapshot.pause.summary}。恢复条件：{snapshot.pause.recoveryCondition}
              </div>
              {permission.canOperateAgent ? (
                <button
                  className={styles.secondaryButton}
                  disabled={!canChange}
                  onClick={() =>
                    setPending({
                      title: '恢复自动化？',
                      description: '恢复只解除暂停门禁，不会改变已有能力开关，也不会开启提交能力。',
                      confirmLabel: '确认恢复',
                      change: { kind: 'resume' },
                    })
                  }
                  type="button"
                >
                  检查并恢复
                </button>
              ) : null}
            </div>
          ) : null}

          <div className={styles.capabilityList}>
            {CAPABILITY_ORDER.map((capability) => {
              const content = CAPABILITY_CONTENT[capability];
              const mutable = isMutableCapability(capability);
              const enabled = mutable ? snapshot.capabilities[capability] : false;
              return (
                <div className={styles.capabilityRow} key={capability}>
                  <div>
                    <h3>{content.label}</h3>
                    <p>{content.description}</p>
                  </div>
                  <div className={styles.capabilityMeta}>
                    {!mutable ? <span className={styles.locked}>固定关闭</span> : null}
                    <button
                      aria-checked={enabled}
                      aria-label={`${content.label}：${enabled ? '已开启' : '已关闭'}`}
                      className={styles.switch}
                      disabled={!mutable || !canChange}
                      onClick={() => {
                        if (!mutable) {
                          return;
                        }
                        setPending({
                          title: `${enabled ? '关闭' : '开启'}${content.label}？`,
                          description: `${content.impact} 当前状态只有在审计写入成功后才会更新。`,
                          confirmLabel: `确认${enabled ? '关闭' : '开启'}`,
                          dangerous: !enabled,
                          change: {
                            kind: 'capability',
                            capability,
                            enabled: !enabled,
                          },
                        });
                      }}
                      role="switch"
                      type="button"
                    >
                      <span className={styles.switchThumb} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeading}>
              <h3>执行限额</h3>
              <span>未批准/留空 = 可执行申请数为 0</span>
            </div>
            <div className={styles.limitGrid}>
              <div className={styles.field}>
                <label htmlFor="daily-limit">每日申请上限</label>
                <input
                  className={styles.input}
                  disabled={!canChange}
                  id="daily-limit"
                  inputMode="numeric"
                  min="1"
                  onChange={(event) => setDailyLimit(event.target.value)}
                  placeholder="未批准"
                  type="number"
                  value={dailyLimit}
                />
                {limitErrors.dailyApplications ? (
                  <span className={styles.fieldError}>{limitErrors.dailyApplications}</span>
                ) : null}
              </div>
              <div className={styles.field}>
                <label htmlFor="company-limit">单公司上限</label>
                <input
                  className={styles.input}
                  disabled={!canChange}
                  id="company-limit"
                  inputMode="numeric"
                  min="1"
                  onChange={(event) => setCompanyLimit(event.target.value)}
                  placeholder="未批准"
                  type="number"
                  value={companyLimit}
                />
                {limitErrors.perCompanyApplications ? (
                  <span className={styles.fieldError}>{limitErrors.perCompanyApplications}</span>
                ) : null}
              </div>
              <div className={styles.field}>
                <label htmlFor="concurrent-tasks">并发任务数</label>
                <input
                  className={styles.input}
                  disabled={!canChange}
                  id="concurrent-tasks"
                  inputMode="numeric"
                  min="1"
                  onChange={(event) => setConcurrentTasks(event.target.value)}
                  type="number"
                  value={concurrentTasks}
                />
                {limitErrors.concurrentTasks ? (
                  <span className={styles.fieldError}>{limitErrors.concurrentTasks}</span>
                ) : null}
              </div>
            </div>
            <p className={styles.helper}>
              当前有效单日/单公司交集上限：{effectiveApplicationLimit(limitDraft)}
              。限额不会绕过人工提交确认。
            </p>
            <div className={styles.actionRow}>
              {permission.canOperateAgent && !snapshot.pause ? (
                <button
                  className={styles.secondaryButton}
                  disabled={!canChange}
                  onClick={() =>
                    setPending({
                      title: '暂停全部自动化？',
                      description:
                        '暂停会阻止新自动化任务，但不会撤销代理配对，也不会改变现有能力开关。',
                      confirmLabel: '确认暂停',
                      dangerous: true,
                      change: {
                        kind: 'pause',
                        pause: {
                          scope: 'global',
                          reason: 'user_requested',
                          summary: '用户从自动化控制台暂停',
                          recoveryCondition: '用户确认风险后显式恢复',
                          pausedAt: new Date().toISOString(),
                        },
                      },
                    })
                  }
                  type="button"
                >
                  暂停全部自动化
                </button>
              ) : null}
              <button
                className={styles.primaryButton}
                disabled={
                  !canChange ||
                  Object.keys(limitErrors).length > 0 ||
                  JSON.stringify(limitDraft) === JSON.stringify(snapshot.limits)
                }
                onClick={() =>
                  setPending({
                    title: '更新执行限额？',
                    description: '新限额将影响后续任务调度；正在执行的任务仍受提交前人工确认保护。',
                    confirmLabel: '确认并保存限额',
                    change: { kind: 'limits', limits: limitDraft },
                  })
                }
                type="button"
              >
                保存限额
              </button>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeading}>
              <h3>最近审计</h3>
              <span>只显示脱敏动作与时间</span>
            </div>
            {snapshot.auditEvents.length > 0 ? (
              <ul className={styles.auditList}>
                {snapshot.auditEvents.map((event) => (
                  <li className={styles.auditItem} key={event.eventId}>
                    <code>{event.action}</code>
                    <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>尚无设置变更。开关与限额保持安全默认值。</p>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        busy={busy}
        confirmLabel={pending?.confirmLabel ?? '确认'}
        dangerous={pending?.dangerous}
        description={pending?.description ?? ''}
        onCancel={() => setPending(null)}
        onConfirm={() => void applyPendingChange()}
        open={pending !== null}
        title={pending?.title ?? ''}
      />
    </section>
  );
}
