import type { Agent, Application, Task } from './contracts';

const userId = '10000000-0000-4000-8000-000000000001';

export const mockAgent: Agent = {
  id: '60000000-0000-4000-8000-000000000001',
  user_id: userId,
  device_name: 'Alex’s MacBook',
  public_key_thumbprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  status: 'online',
  scopes: ['agent:commands:claim', 'agent:receipts:write', 'agent:heartbeat:write'],
  authorization_version: 4,
  last_seen_at: '2026-07-30T19:18:00Z',
  version: 7,
  created_at: '2026-07-20T10:00:00Z',
  updated_at: '2026-07-30T19:18:00Z',
};

export const mockTasks: Task[] = [
  {
    id: '70000000-0000-4000-8000-000000000001',
    user_id: userId,
    type: 'fill_application',
    status: 'requires_human',
    resource: { type: 'application', id: '80000000-0000-4000-8000-000000000001' },
    attempt: 1,
    max_attempts: 3,
    manual_reason: 'work_authorization_ambiguous',
    created_at: '2026-07-30T17:10:00Z',
    updated_at: '2026-07-30T18:02:00Z',
  },
  {
    id: '70000000-0000-4000-8000-000000000002',
    user_id: userId,
    type: 'generate_material',
    status: 'queued',
    resource: { type: 'job', id: '90000000-0000-4000-8000-000000000001' },
    attempt: 0,
    max_attempts: 3,
    created_at: '2026-07-30T18:32:00Z',
    updated_at: '2026-07-30T18:32:00Z',
  },
];

const applicationBase = {
  user_id: userId,
  goal_id: '20000000-0000-4000-8000-000000000001',
  material_ids: ['40000000-0000-4000-8000-000000000001'],
  version: 2,
  created_at: '2026-07-29T11:00:00Z',
};

export const mockApplications: Application[] = [
  {
    ...applicationBase,
    id: '80000000-0000-4000-8000-000000000001',
    job_id: '90000000-0000-4000-8000-000000000002',
    status: 'manual_required',
    submission_idempotency_key: 'apply-fieldnotes-product-engineer-v2',
    evidence: [],
    timeline: [{
      id: '81000000-0000-4000-8000-000000000001',
      from_status: 'filling',
      to_status: 'manual_required',
      actor: { type: 'agent', id: mockAgent.id },
      occurred_at: '2026-07-30T18:02:00Z',
      reason_code: 'work_authorization_ambiguous',
    }],
    manual_reason: 'work_authorization_ambiguous',
    updated_at: '2026-07-30T18:02:00Z',
  },
  {
    ...applicationBase,
    id: '80000000-0000-4000-8000-000000000002',
    job_id: '90000000-0000-4000-8000-000000000001',
    status: 'awaiting_confirmation',
    submission_idempotency_key: 'apply-northstar-frontend-v4',
    evidence: [],
    timeline: [{
      id: '81000000-0000-4000-8000-000000000002',
      from_status: 'filling',
      to_status: 'awaiting_confirmation',
      actor: { type: 'agent', id: mockAgent.id },
      occurred_at: '2026-07-30T18:34:00Z',
      reason_code: 'user_confirmation_required',
    }],
    updated_at: '2026-07-30T18:34:00Z',
  },
  {
    ...applicationBase,
    id: '80000000-0000-4000-8000-000000000003',
    job_id: '90000000-0000-4000-8000-000000000003',
    status: 'submitted_pending_verification',
    submission_idempotency_key: 'apply-redwood-ui-v1',
    evidence: [{
      type: 'manual_attestation',
      reference: 'user-reported',
      captured_at: '2026-07-30T16:20:00Z',
      target_origin: 'https://careers.redwood.example',
      verified: false,
    }],
    timeline: [{
      id: '81000000-0000-4000-8000-000000000003',
      from_status: 'awaiting_confirmation',
      to_status: 'submitted_pending_verification',
      actor: { type: 'user', id: userId },
      occurred_at: '2026-07-30T16:20:00Z',
      reason_code: 'submission_result_uncertain',
    }],
    updated_at: '2026-07-30T16:20:00Z',
  },
  {
    ...applicationBase,
    id: '80000000-0000-4000-8000-000000000004',
    job_id: '90000000-0000-4000-8000-000000000004',
    status: 'submitted',
    submission_idempotency_key: 'apply-lattice-platform-v3',
    evidence: [{
      type: 'confirmation_number',
      reference: 'mock-confirmation-1842',
      captured_at: '2026-07-30T14:10:00Z',
      target_origin: 'https://jobs.lever.co',
      verified: true,
    }],
    timeline: [{
      id: '81000000-0000-4000-8000-000000000004',
      from_status: 'awaiting_confirmation',
      to_status: 'submitted',
      actor: { type: 'user', id: userId },
      occurred_at: '2026-07-30T14:10:00Z',
      reason_code: 'verified_confirmation_number',
    }],
    updated_at: '2026-07-30T14:10:00Z',
  },
];

export async function loadDashboardMock() {
  return Promise.resolve({ agent: mockAgent, tasks: mockTasks, applications: mockApplications });
}
