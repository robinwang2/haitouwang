'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getApprovalBlockers, InMemoryReviewDecisionGateway } from './review-workflow';
import type {
  AuditEvent,
  ReviewCapabilities,
  ReviewCase,
  ReviewDecisionGateway,
  ReviewMaterial,
  ReviewPageState,
} from './types';
import styles from './review-center.module.css';

const reviewerLabels = {
  ats: 'ATS',
  hard_requirements: '硬条件',
  matching: '岗位匹配',
  skeptical_recruiter: '招聘官',
  hiring_manager: '用人经理',
  fact_check: '事实一致性',
  naturalness: '自然度',
} as const;

const defaultCapabilities: ReviewCapabilities = {
  canViewFacts: true,
  canEdit: true,
  canDecide: true,
};

export interface ReviewCenterProps {
  readonly initialReview?: ReviewCase;
  readonly pageState?: ReviewPageState;
  readonly capabilities?: ReviewCapabilities;
  readonly pausedReason?: string;
  readonly gateway?: ReviewDecisionGateway;
  readonly actorId?: string;
  readonly onRetry?: () => void;
}

type Dialog = 'approve' | 'reject' | null;

export function ReviewCenter({
  initialReview,
  pageState = 'ready',
  capabilities = defaultCapabilities,
  pausedReason,
  gateway: suppliedGateway,
  actorId = 'current-user',
  onRetry,
}: ReviewCenterProps) {
  const fallbackGateway = useMemo(() => new InMemoryReviewDecisionGateway(), []);
  const gateway = suppliedGateway ?? fallbackGateway;
  const [review, setReview] = useState(initialReview);
  const [selectedMaterialId, setSelectedMaterialId] = useState(
    initialReview?.materials[0]?.id ?? '',
  );
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();
  const [editingStatementId, setEditingStatementId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [unsynced, setUnsynced] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectNote, setRejectNote] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (dialog) dialogTitleRef.current?.focus();
  }, [dialog]);

  useEffect(() => {
    setReview(initialReview);
    setSelectedMaterialId(initialReview?.materials[0]?.id ?? '');
  }, [initialReview]);

  if (pageState === 'permission_denied') {
    return <PageMessage title="无法查看审核中心" detail="当前账号没有查看材料审核内容的权限。" />;
  }
  if (pageState === 'loading') {
    return (
      <main className={styles.shell} aria-busy="true">
        <h1>材料审核中心</h1>
        <p className={styles.muted}>正在分段加载材料与独立评审结果…</p>
        <div className={styles.skeleton} aria-hidden="true" />
      </main>
    );
  }
  if (pageState === 'error') {
    return (
      <PageMessage
        title="审核内容加载失败"
        detail="已保留当前筛选和本地草稿。"
        actionLabel="重试"
        onAction={onRetry}
        alert
      />
    );
  }
  if (pageState === 'empty' || !review) {
    return (
      <PageMessage title="暂无待审核材料" detail="从职位池生成定制材料后，审核任务会出现在这里。" />
    );
  }

  const selectedMaterial =
    review.materials.find((item) => item.id === selectedMaterialId) ?? review.materials[0];
  const blockers = getApprovalBlockers(review, capabilities);
  const warningCount = review.findings.filter(
    (finding) => finding.severity === 'warning' && finding.status === 'open',
  ).length;
  const context = { actor: { type: 'user' as const, id: actorId } };

  async function saveEdit(material: ReviewMaterial, statementId: string) {
    setSaving(true);
    setError('');
    try {
      const result = await gateway.saveMaterialEdit(
        review!,
        material.id,
        statementId,
        draft,
        context,
      );
      setAuditEvents((items) => [result.auditEvent, ...items]);
      if (!result.accepted) {
        setError(result.error ?? '保存失败，本地草稿仍在。');
        setUnsynced(true);
        return;
      }
      setReview(result.review);
      setEditingStatementId(undefined);
      setUnsynced(false);
      setNotice('草稿已保存为新版本，并记录审计事件。');
    } catch {
      setError('保存失败，本地草稿尚未同步，请稍后重试。');
      setUnsynced(true);
    } finally {
      setSaving(false);
    }
  }

  async function resolveFinding(findingId: string) {
    const result = await gateway.resolveFinding(
      review!,
      findingId,
      resolutions[findingId] ?? '',
      context,
    );
    setAuditEvents((items) => [result.auditEvent, ...items]);
    if (!result.accepted) {
      setError(result.error ?? '无法标记为已解决。');
      return;
    }
    setReview(result.review);
    setNotice('问题已关联解决说明并关闭。');
    setError('');
  }

  async function approve() {
    const result = await gateway.approve(review!, capabilities, context);
    setAuditEvents((items) => [result.auditEvent, ...items]);
    setDialog(null);
    if (!result.accepted) {
      setError(result.error ?? '当前材料不能批准。');
      return;
    }
    setReview(result.review);
    setNotice('材料已批准，可进入辅助填写准备；这不代表已申请或已投递。');
  }

  async function answerQuestion(questionId: string) {
    const result = await gateway.answerQuestion(
      review!,
      questionId,
      answers[questionId] ?? '',
      context,
    );
    setAuditEvents((items) => [result.auditEvent, ...items]);
    if (!result.accepted) {
      setError(result.error ?? '无法保存答案。');
      return;
    }
    setReview(result.review);
    setNotice('回答已保存，批准门禁状态已重新计算。');
    setError('');
  }

  async function reject() {
    const result = await gateway.reject(review!, rejectReason, rejectNote, capabilities, context);
    setAuditEvents((items) => [result.auditEvent, ...items]);
    if (!result.accepted) {
      setError(result.error ?? '无法拒绝当前材料。');
      return;
    }
    setReview(result.review);
    setDialog(null);
    setNotice('当前材料版本已拒绝，职位和历史版本仍保留。');
    setError('');
  }

  return (
    <main className={styles.shell}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>审核队列 · 第 {review.round} 轮</p>
          <h1>材料审核中心</h1>
          <p>
            {review.companyName} · {review.jobTitle}
          </p>
        </div>
        <div className={styles.statusStack}>
          <Status
            label={`评审建议：${recommendationLabel(review.recommendation)}`}
            tone={review.recommendation === 'approve' ? 'good' : 'warn'}
          />
          <span className={styles.muted}>
            审核版本 v{review.version} · {formatDate(review.updatedAt)}
          </span>
        </div>
      </header>

      {pausedReason ? (
        <div className={styles.paused} role="status">
          ⏸ 已暂停：{pausedReason}。现有材料仍可查看和编辑。
        </div>
      ) : null}
      {!capabilities.canDecide ? (
        <div className={styles.permission} role="status">
          只读审核权限：批准与拒绝操作不可用。
        </div>
      ) : null}
      {notice ? (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      {unsynced ? (
        <div className={styles.error} role="status">
          本地草稿尚未同步，请勿关闭页面。
        </div>
      ) : null}

      <section className={styles.summary} aria-labelledby="requirements-title">
        <div>
          <h2 id="requirements-title">职位硬条件</h2>
          <ul>
            {review.hardRequirements.map((requirement) => (
              <li key={requirement}>✓ {requirement}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2>批准门禁</h2>
          {blockers.length ? (
            <ul className={styles.blockers}>
              {blockers.map((blocker) => (
                <li key={blocker.code}>阻塞 · {blocker.message}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.good}>✓ 所有门禁均已通过</p>
          )}
        </div>
      </section>

      <div className={styles.workspace}>
        <section className={styles.materialPanel} aria-labelledby="material-title">
          <div className={styles.tabs} role="tablist" aria-label="材料类型">
            {review.materials.map((material) => (
              <button
                key={material.id}
                type="button"
                role="tab"
                aria-selected={material.id === selectedMaterial.id}
                className={material.id === selectedMaterial.id ? styles.activeTab : ''}
                onClick={() => setSelectedMaterialId(material.id)}
              >
                {material.label} · v{material.version}
              </button>
            ))}
          </div>
          <h2 id="material-title">{selectedMaterial.label}正文</h2>
          <div className={styles.statements}>
            {selectedMaterial.statements.map((statement) => {
              const active = statement.evidenceIds.includes(selectedEvidenceId ?? '');
              return (
                <article
                  key={statement.id}
                  className={active ? styles.highlighted : styles.statement}
                >
                  {editingStatementId === statement.id ? (
                    <>
                      <label htmlFor={`statement-${statement.id}`}>编辑陈述</label>
                      <textarea
                        id={`statement-${statement.id}`}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={5}
                      />
                      <div className={styles.inlineActions}>
                        <button
                          type="button"
                          onClick={() => saveEdit(selectedMaterial, statement.id)}
                          disabled={saving}
                        >
                          {saving ? '保存中…' : '保存为新版本'}
                        </button>
                        <button
                          type="button"
                          className={styles.secondary}
                          onClick={() => setEditingStatementId(undefined)}
                        >
                          取消编辑
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>{statement.text}</p>
                      <div className={styles.statementFooter}>
                        <span>
                          {statement.evidenceIds.length
                            ? `${statement.evidenceIds.length} 项事实依据`
                            : '⚠ 无事实来源'}
                        </span>
                        <button
                          type="button"
                          className={styles.textButton}
                          disabled={!capabilities.canEdit || review.status === 'approved'}
                          onClick={() => {
                            setEditingStatementId(statement.id);
                            setDraft(statement.text);
                          }}
                        >
                          编辑陈述
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>

          <h2>相对基础版本的差异</h2>
          <ul className={styles.diffList}>
            {selectedMaterial.differences.map((difference) => (
              <li key={difference.id}>
                <strong>
                  {difference.kind === 'added'
                    ? '＋ 新增'
                    : difference.kind === 'removed'
                      ? '－ 删除'
                      : '↔ 修改'}
                </strong>
                {difference.before ? (
                  <p>
                    <span>原文：</span>
                    {difference.before}
                  </p>
                ) : null}
                {difference.after ? (
                  <p>
                    <span>现文：</span>
                    {difference.after}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <aside className={styles.evidencePanel} aria-labelledby="evidence-title">
          <h2 id="evidence-title">事实证据</h2>
          {!capabilities.canViewFacts ? (
            <p className={styles.muted}>事实内容已按权限遮盖。</p>
          ) : (
            <ul className={styles.evidenceList}>
              {review.evidence.map((evidence) => (
                <li
                  key={evidence.id}
                  className={evidence.id === selectedEvidenceId ? styles.selectedEvidence : ''}
                >
                  <button type="button" onClick={() => setSelectedEvidenceId(evidence.id)}>
                    <strong>{evidence.label}</strong>
                    <span>
                      来源：{evidence.sourceLabel} · v{evidence.version}
                    </span>
                    <span>范围：{evidence.allowedScope}</span>
                    <Status
                      label={
                        evidence.allowed && evidence.state === 'confirmed'
                          ? '已确认且范围允许'
                          : evidence.state === 'pending'
                            ? '待确认 · 阻塞'
                            : '不允许使用 · 阻塞'
                      }
                      tone={evidence.allowed && evidence.state === 'confirmed' ? 'good' : 'bad'}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <section className={styles.results} aria-labelledby="reviewer-title">
        <h2 id="reviewer-title">独立评审结果</h2>
        <div className={styles.resultGrid}>
          {review.reviewerResults.map((result) => (
            <article key={result.reviewer}>
              <h3>{reviewerLabels[result.reviewer]}</h3>
              <Status
                label={
                  result.status === 'completed'
                    ? '评审完成'
                    : result.status === 'failed'
                      ? '评审失败 · 结果不完整'
                      : '评审进行中'
                }
                tone={
                  result.status === 'completed'
                    ? 'good'
                    : result.status === 'failed'
                      ? 'bad'
                      : 'warn'
                }
              />
              <p>{result.summary ?? '等待评审结果。'}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.findings} aria-labelledby="finding-title">
        <h2 id="finding-title">问题与建议</h2>
        {review.findings.map((finding) => (
          <article
            key={finding.id}
            className={finding.severity === 'must_fix' ? styles.mustFix : styles.finding}
          >
            <div>
              <Status
                label={
                  finding.severity === 'must_fix'
                    ? '必须修复'
                    : finding.severity === 'warning'
                      ? '建议'
                      : '提示'
                }
                tone={finding.severity === 'must_fix' ? 'bad' : 'warn'}
              />
              <h3>{finding.category}</h3>
              <p>{finding.message}</p>
              <p className={styles.muted}>
                评审者：{reviewerLabels[finding.reviewer]} · 状态：
                {finding.status === 'open' ? '未关闭' : '已解决'}
              </p>
            </div>
            {finding.status === 'open' && capabilities.canEdit ? (
              <div className={styles.resolution}>
                <label htmlFor={`resolution-${finding.id}`}>修订引用或解决说明（必填）</label>
                <input
                  id={`resolution-${finding.id}`}
                  value={resolutions[finding.id] ?? ''}
                  onChange={(event) =>
                    setResolutions((items) => ({ ...items, [finding.id]: event.target.value }))
                  }
                />
                <button type="button" onClick={() => resolveFinding(finding.id)}>
                  关联说明并标记已解决
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <section className={styles.questions} aria-labelledby="question-title">
        <h2 id="question-title">待用户回答</h2>
        {review.questions.length === 0 ? (
          <p className={styles.muted}>没有待回答问题。</p>
        ) : (
          review.questions.map((question) => (
            <article key={question.id}>
              <div>
                <strong>{question.prompt}</strong>
                <p className={styles.muted}>
                  {question.required ? '必答 · 未回答时阻止批准' : '选答'}
                </p>
              </div>
              {question.answer ? (
                <p>
                  <Status label="已回答" tone="good" /> {question.answer}
                </p>
              ) : capabilities.canEdit ? (
                <div className={styles.resolution}>
                  <label htmlFor={`answer-${question.id}`}>
                    回答{question.required ? '（必填）' : ''}
                  </label>
                  <input
                    id={`answer-${question.id}`}
                    value={answers[question.id] ?? ''}
                    onChange={(event) =>
                      setAnswers((items) => ({ ...items, [question.id]: event.target.value }))
                    }
                  />
                  <button type="button" onClick={() => answerQuestion(question.id)}>
                    保存回答
                  </button>
                </div>
              ) : (
                <p className={styles.muted}>当前账号不能回答此问题。</p>
              )}
            </article>
          ))
        )}
      </section>

      <section className={styles.audit} aria-labelledby="audit-title">
        <h2 id="audit-title">本次审核活动</h2>
        {auditEvents.length ? (
          <ol>
            {auditEvents.map((event) => (
              <li key={event.event_id}>
                {formatDate(event.occurred_at)} · {event.action} ·{' '}
                {event.outcome === 'succeeded' ? '成功' : `已拒绝（${event.reason_code}）`}
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.muted}>尚无本次会话产生的决定。</p>
        )}
      </section>

      <footer className={styles.actionBar}>
        <div>
          <strong>当前版本 v{review.version}</strong>
          <span>
            {blockers.length ? `${blockers.length} 类门禁未通过` : `${warningCount} 项未关闭建议`}
          </span>
        </div>
        <button
          type="button"
          className={styles.secondary}
          disabled={!capabilities.canDecide || review.status === 'approved'}
          onClick={() => setDialog('reject')}
        >
          拒绝当前版本
        </button>
        <button
          type="button"
          disabled={blockers.length > 0 || review.status === 'approved' || unsynced}
          aria-describedby={blockers.length ? 'approval-help' : undefined}
          onClick={() => setDialog('approve')}
        >
          批准进入辅助填写准备
        </button>
        {blockers.length ? (
          <span id="approval-help" className={styles.srOnly}>
            批准不可用：{blockers.map((item) => item.message).join('；')}
          </span>
        ) : null}
      </footer>

      {dialog ? (
        <div className={styles.backdrop}>
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <h2 id="dialog-title" ref={dialogTitleRef} tabIndex={-1}>
              {dialog === 'approve' ? '确认批准当前材料版本' : '拒绝当前材料版本'}
            </h2>
            <p>
              {review.companyName} · {review.jobTitle} · 材料版本 v{review.version}
            </p>
            {dialog === 'approve' ? (
              <>
                <p>
                  仍有 {warningCount} 项建议未关闭。批准后材料仅可进入辅助填写准备，不会提交申请。
                </p>
                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    autoFocus
                    onClick={() => setDialog(null)}
                  >
                    返回继续检查
                  </button>
                  <button type="button" onClick={approve}>
                    确认批准材料
                  </button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="reject-reason">拒绝原因（必填）</label>
                <select
                  id="reject-reason"
                  value={rejectReason}
                  onChange={(event) => setRejectReason(event.target.value)}
                >
                  <option value="">请选择原因</option>
                  <option value="FACT_INCORRECT">事实不准确</option>
                  <option value="POSITIONING_MISMATCH">定位不匹配</option>
                  <option value="REWRITE_REQUIRED">需要整体重写</option>
                  <option value="NO_LONGER_NEEDED">不再需要此材料</option>
                </select>
                <label htmlFor="reject-note">补充说明（可选）</label>
                <textarea
                  id="reject-note"
                  rows={3}
                  value={rejectNote}
                  onChange={(event) => setRejectNote(event.target.value)}
                />
                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    autoFocus
                    onClick={() => setDialog(null)}
                  >
                    取消拒绝
                  </button>
                  <button type="button" disabled={!rejectReason} onClick={reject}>
                    确认拒绝当前版本
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}

function Status({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: 'good' | 'warn' | 'bad';
}) {
  return (
    <span className={`${styles.status} ${styles[tone]}`}>
      {tone === 'good' ? '✓' : tone === 'bad' ? '!' : '◆'} {label}
    </span>
  );
}

function PageMessage({
  title,
  detail,
  actionLabel,
  onAction,
  alert = false,
}: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly alert?: boolean;
}) {
  return (
    <main className={styles.message} role={alert ? 'alert' : undefined}>
      <h1>{title}</h1>
      <p>{detail}</p>
      {actionLabel ? (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </main>
  );
}

function recommendationLabel(value: ReviewCase['recommendation']): string {
  return {
    approve: '可批准',
    revise: '修改后复核',
    reject: '建议拒绝',
    human_review: '需人工审核',
  }[value];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
