import type {
  AuditEvent,
  CommandContext,
  DecisionResult,
  ReviewCapabilities,
  ReviewCase,
  ReviewDecisionGateway,
} from './types';

export type ApprovalBlockerCode =
  | 'MUST_FIX_OPEN'
  | 'REQUIRED_ANSWER_MISSING'
  | 'FACT_EVIDENCE_INVALID'
  | 'REVIEW_INCOMPLETE'
  | 'DECISION_PERMISSION_REQUIRED';

export interface ApprovalBlocker {
  readonly code: ApprovalBlockerCode;
  readonly message: string;
  readonly count: number;
}

export function getApprovalBlockers(review: ReviewCase, capabilities: ReviewCapabilities): ApprovalBlocker[] {
  const blockers: ApprovalBlocker[] = [];
  const mustFixCount = review.findings.filter(
    (finding) => finding.severity === 'must_fix' && finding.status === 'open',
  ).length;
  const unansweredCount = review.questions.filter(
    (question) => question.required && !question.answer?.trim(),
  ).length;
  const invalidEvidenceCount = review.materials.reduce(
    (count, material) =>
      count +
      material.statements.filter((statement) => {
        if (statement.evidenceIds.length === 0) return true;
        return statement.evidenceIds.some((evidenceId) => {
          const evidence = review.evidence.find((item) => item.id === evidenceId);
          return !evidence || !evidence.allowed || evidence.state !== 'confirmed';
        });
      }).length,
    0,
  );
  const incompleteReviewers = review.reviewerResults.filter((result) => result.status !== 'completed').length;

  if (mustFixCount > 0) {
    blockers.push({ code: 'MUST_FIX_OPEN', count: mustFixCount, message: `${mustFixCount} 项必须修复问题仍未关闭` });
  }
  if (unansweredCount > 0) {
    blockers.push({ code: 'REQUIRED_ANSWER_MISSING', count: unansweredCount, message: `${unansweredCount} 个必答问题尚未回答` });
  }
  if (invalidEvidenceCount > 0) {
    blockers.push({ code: 'FACT_EVIDENCE_INVALID', count: invalidEvidenceCount, message: `${invalidEvidenceCount} 条陈述的事实来源未通过复核` });
  }
  if (incompleteReviewers > 0 || review.status === 'queued' || review.status === 'running' || review.status === 'failed') {
    blockers.push({ code: 'REVIEW_INCOMPLETE', count: Math.max(incompleteReviewers, 1), message: '独立评审尚未全部完成' });
  }
  if (!capabilities.canDecide) {
    blockers.push({ code: 'DECISION_PERMISSION_REQUIRED', count: 1, message: '当前账号没有批准或拒绝权限' });
  }
  return blockers;
}

export function canApprove(review: ReviewCase, capabilities: ReviewCapabilities): boolean {
  return getApprovalBlockers(review, capabilities).length === 0;
}

function id(context: CommandContext): string {
  return context.createId?.() ?? crypto.randomUUID();
}

function audit(
  review: ReviewCase,
  context: CommandContext,
  details: Pick<AuditEvent, 'action' | 'outcome' | 'changed_fields'> &
    Partial<Pick<AuditEvent, 'reason_code' | 'from_status' | 'to_status'>>,
): AuditEvent {
  return {
    event_id: id(context),
    tenant_id: review.tenantId,
    occurred_at: (context.now?.() ?? new Date()).toISOString(),
    actor: context.actor,
    action: details.action,
    resource: { type: 'review', id: review.id, version: review.version },
    outcome: details.outcome,
    reason_code: details.reason_code,
    request_id: context.requestId ?? id(context),
    correlation_id: context.correlationId ?? id(context),
    changed_fields: details.changed_fields,
    from_status: details.from_status,
    to_status: details.to_status,
  };
}

function rejected(
  review: ReviewCase,
  context: CommandContext,
  action: AuditEvent['action'],
  reasonCode: string,
  error: string,
): DecisionResult {
  return {
    accepted: false,
    review,
    error,
    auditEvent: audit(review, context, { action, outcome: 'rejected', reason_code: reasonCode, changed_fields: [] }),
  };
}

/**
 * Explicit in-memory Mock used until the API contract exposes review mutation endpoints.
 * The append happens before a successful result is returned, mirroring an atomic
 * business-write + audit-outbox operation.
 */
export class InMemoryReviewDecisionGateway implements ReviewDecisionGateway {
  readonly auditEvents: AuditEvent[] = [];

  private record(result: DecisionResult): DecisionResult {
    this.auditEvents.push(result.auditEvent);
    return result;
  }

  async saveMaterialEdit(
    review: ReviewCase,
    materialId: string,
    statementId: string,
    text: string,
    context: CommandContext,
  ): Promise<DecisionResult> {
    const material = review.materials.find((item) => item.id === materialId);
    const statement = material?.statements.find((item) => item.id === statementId);
    if (!material || !statement || !text.trim()) {
      return this.record(rejected(review, context, 'review.material_edited', 'VALIDATION_FAILED', '正文不能为空。'));
    }
    const nextReview: ReviewCase = {
      ...review,
      status: 'requires_changes',
      version: review.version + 1,
      updatedAt: (context.now?.() ?? new Date()).toISOString(),
      materials: review.materials.map((item) =>
        item.id !== materialId
          ? item
          : {
              ...item,
              version: item.version + 1,
              statements: item.statements.map((candidate) =>
                candidate.id === statementId ? { ...candidate, text: text.trim() } : candidate,
              ),
            },
      ),
    };
    return this.record({
      accepted: true,
      review: nextReview,
      auditEvent: audit(review, context, {
        action: 'review.material_edited',
        outcome: 'succeeded',
        changed_fields: ['materials.statements.text', 'materials.version', 'version', 'status'],
        from_status: review.status,
        to_status: nextReview.status,
      }),
    });
  }

  async resolveFinding(
    review: ReviewCase,
    findingId: string,
    resolution: string,
    context: CommandContext,
  ): Promise<DecisionResult> {
    const finding = review.findings.find((item) => item.id === findingId);
    if (!finding || !resolution.trim()) {
      return this.record(rejected(review, context, 'review.finding_resolved', 'RESOLUTION_REQUIRED', '请关联修订或填写解决说明。'));
    }
    const nextReview: ReviewCase = {
      ...review,
      version: review.version + 1,
      updatedAt: (context.now?.() ?? new Date()).toISOString(),
      findings: review.findings.map((item) =>
        item.id === findingId ? { ...item, status: 'resolved', resolution: resolution.trim() } : item,
      ),
    };
    return this.record({
      accepted: true,
      review: nextReview,
      auditEvent: audit(review, context, {
        action: 'review.finding_resolved',
        outcome: 'succeeded',
        changed_fields: ['findings.status', 'findings.resolution', 'version'],
      }),
    });
  }

  async answerQuestion(
    review: ReviewCase,
    questionId: string,
    answer: string,
    context: CommandContext,
  ): Promise<DecisionResult> {
    const question = review.questions.find((item) => item.id === questionId);
    if (!question || !answer.trim()) {
      return this.record(rejected(review, context, 'review.question_answered', 'ANSWER_REQUIRED', '请填写问题答案。'));
    }
    const nextReview: ReviewCase = {
      ...review,
      version: review.version + 1,
      updatedAt: (context.now?.() ?? new Date()).toISOString(),
      questions: review.questions.map((item) =>
        item.id === questionId ? { ...item, answer: answer.trim() } : item,
      ),
      evidence: question.evidenceId && question.confirmationAnswer?.trim() === answer.trim()
        ? review.evidence.map((item) =>
            item.id === question.evidenceId ? { ...item, state: 'confirmed' } : item,
          )
        : review.evidence,
    };
    return this.record({
      accepted: true,
      review: nextReview,
      auditEvent: audit(review, context, {
        action: 'review.question_answered',
        outcome: 'succeeded',
        changed_fields: question.evidenceId && question.confirmationAnswer?.trim() === answer.trim()
          ? ['questions.answer', 'evidence.state', 'version']
          : ['questions.answer', 'version'],
      }),
    });
  }

  async approve(
    review: ReviewCase,
    capabilities: ReviewCapabilities,
    context: CommandContext,
  ): Promise<DecisionResult> {
    const blockers = getApprovalBlockers(review, capabilities);
    if (blockers.length > 0) {
      return this.record(
        rejected(review, context, 'review.approved', blockers[0].code, blockers.map((item) => item.message).join('；')),
      );
    }
    const nextReview: ReviewCase = {
      ...review,
      status: 'approved',
      recommendation: 'approve',
      version: review.version + 1,
      updatedAt: (context.now?.() ?? new Date()).toISOString(),
    };
    return this.record({
      accepted: true,
      review: nextReview,
      auditEvent: audit(review, context, {
        action: 'review.approved',
        outcome: 'succeeded',
        changed_fields: ['status', 'recommendation', 'version'],
        from_status: review.status,
        to_status: 'approved',
      }),
    });
  }

  async reject(
    review: ReviewCase,
    reason: string,
    note: string,
    capabilities: ReviewCapabilities,
    context: CommandContext,
  ): Promise<DecisionResult> {
    if (!capabilities.canDecide) {
      return this.record(rejected(review, context, 'review.rejected', 'DECISION_PERMISSION_REQUIRED', '当前账号没有拒绝权限。'));
    }
    if (!reason.trim()) {
      return this.record(rejected(review, context, 'review.rejected', 'REJECTION_REASON_REQUIRED', '请选择拒绝原因。'));
    }
    const nextReview: ReviewCase = {
      ...review,
      status: 'rejected',
      recommendation: 'reject',
      version: review.version + 1,
      updatedAt: (context.now?.() ?? new Date()).toISOString(),
    };
    return this.record({
      accepted: true,
      review: nextReview,
      auditEvent: audit(review, context, {
        action: 'review.rejected',
        outcome: 'succeeded',
        reason_code: reason.trim(),
        changed_fields: note.trim() ? ['status', 'recommendation', 'rejection_note', 'version'] : ['status', 'recommendation', 'version'],
        from_status: review.status,
        to_status: 'rejected',
      }),
    });
  }
}
