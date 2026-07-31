import { createSafeAutomationSnapshot, enforceSafeSnapshot, validateLimits } from './policy';
import type {
  AuditReceipt,
  AutomationChange,
  AutomationGateway,
  AutomationSnapshot,
  ConfirmedAutomationChange,
  ManualTakeoverTask,
  TakeoverMutationResult,
  TakeoverResolution,
} from './types';

function mockId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function assertConfirmed(request: ConfirmedAutomationChange): void {
  if (
    request.confirmation.impactAcknowledged !== true ||
    Number.isNaN(Date.parse(request.confirmation.confirmedAt))
  ) {
    throw new Error('高风险变更缺少有效的显式确认。');
  }
}

function changedFields(change: AutomationChange): readonly string[] {
  switch (change.kind) {
    case 'capability':
      return [`capabilities.${change.capability}`];
    case 'limits':
      return ['limits.dailyApplications', 'limits.perCompanyApplications', 'limits.concurrentTasks'];
    case 'pause':
    case 'resume':
      return ['pause'];
  }
}

function actionName(change: AutomationChange): string {
  switch (change.kind) {
    case 'capability':
      return `automation.${change.capability}.${change.enabled ? 'enabled' : 'disabled'}`;
    case 'limits':
      return 'automation.limits.updated';
    case 'pause':
      return 'automation.paused';
    case 'resume':
      return 'automation.resumed';
  }
}

export function createAutomationMockGateway(
  initialSnapshot: AutomationSnapshot = createSafeAutomationSnapshot(),
): AutomationGateway {
  let snapshot = enforceSafeSnapshot(initialSnapshot);
  let takeoverTasks: ManualTakeoverTask[] = [
    {
      id: 'manual-task-demo-1',
      applicationId: 'application-demo-1',
      company: 'Northstar Labs',
      jobTitle: 'Frontend Engineer',
      sourceUrl: 'https://careers.example.test/jobs/frontend-engineer',
      reason: 'work_authorization_ambiguous',
      occurredAtStep: '完整性检查',
      completedActions: ['打开招聘页面', '填写已确认字段', '上传批准版本的简历'],
      outstandingActions: ['本人确认工作授权答案', '复核全部回答', '决定是否提交'],
      mayHaveSubmitted: false,
      instructions: [
        '在本地浏览器中确认工作授权问题的真实答案。',
        '完成后不要在招聘网站重复创建另一份申请。',
        '若页面内容发生变化，请选择“仍被阻塞”。',
      ],
      deadline: null,
      estimatedMinutes: 6,
      status: 'open',
    },
  ];

  return {
    kind: 'mock',

    async getSnapshot() {
      return snapshot;
    },

    async applyConfirmedChange(request) {
      assertConfirmed(request);
      if (request.expectedRevision !== snapshot.revision) {
        throw new Error('设置已在其他会话更新，请刷新后重试。');
      }

      const change = request.change;
      if (change.kind === 'limits' && Object.keys(validateLimits(change.limits)).length > 0) {
        throw new Error('限额无效，未保存任何更改。');
      }

      const audit: AuditReceipt = {
        eventId: mockId('audit'),
        action: actionName(change),
        occurredAt: new Date().toISOString(),
        outcome: 'succeeded',
        changedFields: changedFields(change),
      };

      const nextCapabilities = { ...snapshot.capabilities };
      let nextLimits = snapshot.limits;
      let nextPause = snapshot.pause;

      switch (change.kind) {
        case 'capability':
          nextCapabilities[change.capability] = change.enabled;
          break;
        case 'limits':
          nextLimits = change.limits;
          break;
        case 'pause':
          nextPause = change.pause;
          break;
        case 'resume':
          nextPause = null;
          break;
      }

      snapshot = enforceSafeSnapshot({
        ...snapshot,
        revision: snapshot.revision + 1,
        loadedAt: new Date().toISOString(),
        capabilities: nextCapabilities,
        limits: nextLimits,
        pause: nextPause,
        auditEvents: [audit, ...snapshot.auditEvents].slice(0, 8),
      });

      return { snapshot, audit };
    },

    async listTakeoverTasks() {
      return takeoverTasks;
    },

    async resolveTakeoverTask(
      taskId: string,
      resolution: TakeoverResolution,
    ): Promise<TakeoverMutationResult> {
      const task = takeoverTasks.find((candidate) => candidate.id === taskId);
      if (!task) {
        throw new Error('人工任务不存在或已被其他会话处理。');
      }

      let status: ManualTakeoverTask['status'];
      switch (resolution.kind) {
        case 'completed':
          status = resolution.evidenceReference ? 'completed' : 'pending_verification';
          break;
        case 'still_blocked':
          if (resolution.note.trim().length === 0) {
            throw new Error('请说明仍被阻塞的原因。');
          }
          status = 'still_blocked';
          break;
        case 'return_to_agent':
          if (task.mayHaveSubmitted) {
            throw new Error('提交结果不确定时不能交还代理继续。');
          }
          status = 'completed';
          break;
        case 'abandon':
          status = 'abandoned';
          break;
      }

      const updated: ManualTakeoverTask = { ...task, status };
      takeoverTasks = takeoverTasks.map((candidate) =>
        candidate.id === taskId ? updated : candidate,
      );

      const audit: AuditReceipt = {
        eventId: mockId('audit'),
        action: `manual_takeover.${resolution.kind}`,
        occurredAt: new Date().toISOString(),
        outcome: 'succeeded',
        changedFields: ['status'],
      };

      snapshot = {
        ...snapshot,
        auditEvents: [audit, ...snapshot.auditEvents].slice(0, 8),
      };

      return { task: updated, audit };
    },
  };
}
