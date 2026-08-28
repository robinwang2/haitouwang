import type { ReviewCase } from './types';

// Mock fixture: replace with the material/fact detail endpoint once that contract is available.
export const mockReviewCase: ReviewCase = {
  id: '23ba5234-c523-4bb5-a219-485160352d77',
  tenantId: 'd558765a-4d56-4dc0-a26f-4600ad6bd40b',
  userId: '88bd4b13-394e-408b-b03d-281610c0af58',
  jobId: '49799991-a438-4c47-840c-5c188c50ba5c',
  jobTitle: '高级前端工程师',
  companyName: '星河科技',
  hardRequirements: ['5 年以上前端经验', '熟悉 React 与 TypeScript', '能够跨团队推进交付'],
  status: 'requires_changes',
  recommendation: 'revise',
  round: 2,
  version: 7,
  updatedAt: '2026-07-31T11:20:00.000Z',
  materials: [
    {
      id: '6e10ab7b-c342-49b1-8e18-2a8408e216d3',
      kind: 'resume',
      label: '定制简历',
      version: 4,
      updatedAt: '2026-07-31T11:16:00.000Z',
      statements: [
        {
          id: 'summary',
          text: '7 年前端开发经验，主导设计系统落地，将核心页面交付周期缩短 30%。',
          evidenceIds: ['fact-experience', 'fact-design-system'],
        },
        {
          id: 'leadership',
          text: '带领 12 人团队完成微前端改造。',
          evidenceIds: ['fact-team-size'],
        },
      ],
      differences: [
        {
          id: 'diff-1',
          kind: 'changed',
          before: '负责设计系统建设。',
          after: '主导设计系统落地，将核心页面交付周期缩短 30%。',
        },
        { id: 'diff-2', kind: 'added', after: '补充 React 性能治理案例。' },
      ],
    },
    {
      id: 'e92a73e2-40cf-4207-96cd-56ec9d6f79a0',
      kind: 'cover_letter',
      label: '求职信',
      version: 3,
      updatedAt: '2026-07-31T11:18:00.000Z',
      statements: [
        {
          id: 'motivation',
          text: '我希望把规模化前端工程经验用于贵公司的全球化产品。',
          evidenceIds: ['fact-experience'],
        },
      ],
      differences: [{ id: 'diff-3', kind: 'removed', before: '通用求职动机段落。' }],
    },
  ],
  evidence: [
    {
      id: 'fact-experience',
      label: '2019–2026 前端工作经历',
      sourceLabel: '工作经历档案',
      version: 3,
      allowed: true,
      allowedScope: '求职材料',
      state: 'confirmed',
    },
    {
      id: 'fact-design-system',
      label: '设计系统交付周期数据',
      sourceLabel: '项目复盘文档',
      version: 2,
      allowed: true,
      allowedScope: '简历与面试',
      state: 'confirmed',
    },
    {
      id: 'fact-team-size',
      label: '团队规模为 12 人',
      sourceLabel: '待用户确认',
      version: 1,
      allowed: true,
      allowedScope: '求职材料',
      state: 'pending',
    },
  ],
  findings: [
    {
      id: 'finding-team-size',
      reviewer: 'fact_check',
      severity: 'must_fix',
      category: '事实一致性',
      message: '“12 人团队”尚无已确认的事实来源，请修订数字或补充确认。',
      evidenceRefs: [{ type: 'fact', id: 'fact-team-size', version: 1 }],
      status: 'open',
    },
    {
      id: 'finding-keyword',
      reviewer: 'ats',
      severity: 'warning',
      category: '关键词',
      message: '可在项目经历中自然补充职位描述里的“可访问性”关键词。',
      evidenceRefs: [{ type: 'job', id: '49799991-a438-4c47-840c-5c188c50ba5c' }],
      status: 'open',
    },
  ],
  reviewerResults: [
    {
      reviewer: 'ats',
      status: 'completed',
      summary: '关键词覆盖良好，存在一项优化建议。',
      evidenceRefs: [],
    },
    {
      reviewer: 'hard_requirements',
      status: 'completed',
      summary: '满足三项硬条件。',
      evidenceRefs: [],
    },
    {
      reviewer: 'matching',
      status: 'completed',
      summary: '经历与岗位范围匹配。',
      evidenceRefs: [],
    },
    {
      reviewer: 'skeptical_recruiter',
      status: 'completed',
      summary: '团队规模陈述需核实。',
      evidenceRefs: [],
    },
    {
      reviewer: 'hiring_manager',
      status: 'completed',
      summary: '技术影响描述具体。',
      evidenceRefs: [],
    },
    {
      reviewer: 'fact_check',
      status: 'completed',
      summary: '发现一项待确认事实。',
      evidenceRefs: [],
    },
    {
      reviewer: 'naturalness',
      status: 'completed',
      summary: '语言自然，无明显模板痕迹。',
      evidenceRefs: [],
    },
  ],
  questions: [
    {
      id: 'question-team-size',
      prompt: '请确认微前端项目团队规模为 12 人；如不准确，请先编辑陈述。',
      required: true,
      evidenceId: 'fact-team-size',
      confirmationAnswer: '确认',
    },
  ],
};
