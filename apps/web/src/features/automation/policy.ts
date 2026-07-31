import type {
  AutomationCapability,
  AutomationLimits,
  AutomationSnapshot,
  ManualReason,
  MutableAutomationCapability,
} from './types';

export const CAPABILITY_ORDER: readonly AutomationCapability[] = [
  'search',
  'material_generation',
  'assisted_fill',
  'submit',
];

export const MUTABLE_CAPABILITIES: readonly MutableAutomationCapability[] = [
  'search',
  'material_generation',
  'assisted_fill',
];

export const CAPABILITY_CONTENT: Readonly<
  Record<
    AutomationCapability,
    {
      readonly label: string;
      readonly description: string;
      readonly impact: string;
    }
  >
> = {
  search: {
    label: '职位搜索',
    description: '从已批准来源更新职位候选，不会发起申请。',
    impact: '代理将按已连接来源搜索和更新职位，可能增加后台网络活动。',
  },
  material_generation: {
    label: '材料生成',
    description: '根据已确认事实生成申请材料草稿，仍需人工审核。',
    impact: '系统将为候选职位创建材料草稿，但不会批准或提交。',
  },
  assisted_fill: {
    label: '辅助填写',
    description: '在本地浏览器填写已确认字段，提交前必须停下。',
    impact: '本地代理会操作招聘页面并上传已批准材料；遇到未知问题立即暂停。',
  },
  submit: {
    label: '自动提交',
    description: 'MVP 固定关闭。每次提交都必须由用户单独确认。',
    impact: '此能力不可在自动化设置中开启。',
  },
};

export const MANUAL_REASON_LABELS: Readonly<Record<ManualReason, string>> = {
  captcha: '需要完成验证码',
  assessment: '需要完成在线测评',
  video_interview: '需要录制视频',
  electronic_signature: '需要本人签名',
  unknown_required_field: '出现未知必填题',
  legal_or_identity_question: '出现法律或身份问题',
  work_authorization_ambiguous: '工作授权答案存在歧义',
  page_structure_changed: '页面结构发生变化',
  submission_result_uncertain: '无法确认是否已经提交',
  credential_required: '登录状态已失效',
  policy_blocked: '策略门禁阻止继续',
  evidence_conflict: '提交证据相互冲突',
};

export function createSafeAutomationSnapshot(now = new Date().toISOString()): AutomationSnapshot {
  return {
    revision: 0,
    loadedAt: now,
    capabilities: {
      search: false,
      material_generation: false,
      assisted_fill: false,
      submit: false,
    },
    limits: {
      dailyApplications: null,
      perCompanyApplications: null,
      concurrentTasks: 1,
    },
    pause: null,
    auditEvents: [],
  };
}

export function enforceSafeSnapshot(snapshot: AutomationSnapshot): AutomationSnapshot {
  return {
    ...snapshot,
    capabilities: {
      search: snapshot.capabilities.search === true,
      material_generation: snapshot.capabilities.material_generation === true,
      assisted_fill: snapshot.capabilities.assisted_fill === true,
      // Product baseline 2.1: no setting or server response may enable this.
      submit: false,
    },
  };
}

export function effectiveApplicationLimit(limits: AutomationLimits): number {
  if (limits.dailyApplications === null || limits.perCompanyApplications === null) {
    return 0;
  }

  return Math.min(limits.dailyApplications, limits.perCompanyApplications);
}

export function validateLimits(limits: AutomationLimits): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  const validateOptional = (
    field: 'dailyApplications' | 'perCompanyApplications',
    label: string,
  ) => {
    const value = limits[field];
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 500)) {
      errors[field] = `${label}必须是 1–500 的整数，未批准时请留空。`;
    }
  };

  validateOptional('dailyApplications', '每日限额');
  validateOptional('perCompanyApplications', '单公司限额');

  if (
    !Number.isInteger(limits.concurrentTasks) ||
    limits.concurrentTasks < 1 ||
    limits.concurrentTasks > 10
  ) {
    errors.concurrentTasks = '并发任务数必须是 1–10 的整数。';
  }

  if (
    limits.dailyApplications !== null &&
    limits.perCompanyApplications !== null &&
    limits.perCompanyApplications > limits.dailyApplications
  ) {
    errors.perCompanyApplications = '单公司限额不能高于每日总限额。';
  }

  return errors;
}

export function isMutableCapability(
  capability: AutomationCapability,
): capability is MutableAutomationCapability {
  return capability !== 'submit';
}
