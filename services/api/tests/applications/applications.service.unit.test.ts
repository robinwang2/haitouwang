import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ApplicationError,
  ApplicationsService,
  InMemoryApplicationsStore,
  type Application,
  type ApplicationStatus,
  type MutationContext,
} from '../../src/modules/applications';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const JOB_ID = '20000000-0000-4000-8000-000000000001';
const GOAL_ID = '30000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '40000000-0000-4000-8000-000000000001';
const AGENT_ID = '50000000-0000-4000-8000-000000000001';

function context(key: string): MutationContext {
  return {
    actor: { type: 'user', id: USER_ID },
    idempotency_key: `application-test:${key}`,
  };
}

async function expectErrorCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code} to be thrown.`);
}

function create(service: ApplicationsService): Promise<Application> {
  return service.createApplication(
    USER_ID,
    {
      job_id: JOB_ID,
      goal_id: GOAL_ID,
      material_ids: [MATERIAL_ID],
      submission_idempotency_key: 'submission:test:0001',
      deadline_at: '2026-08-02T12:00:00.000Z',
    },
    context('create'),
  );
}

function transition(
  service: ApplicationsService,
  application: Application,
  toStatus: ApplicationStatus,
  key: string,
  prerequisites: Record<string, boolean> = {},
): Promise<Application> {
  return service.transitionApplication(
    USER_ID,
    application.id,
    {
      to_status: toStatus,
      reason_code: `move_to_${toStatus}`,
      ...(toStatus === 'submitted_pending_verification'
        ? { confirmation_token: 'x'.repeat(43) }
        : {}),
    },
    {
      ...context(key),
      expected_version: application.version,
      prerequisites,
    },
  );
}

async function reachAwaitingConfirmation(service: ApplicationsService): Promise<Application> {
  let application = await create(service);
  application = await transition(service, application, 'materials_ready', 'ready');
  application = await transition(service, application, 'approved', 'approved', {
    materials_approved: true,
    no_open_must_fix: true,
  });
  application = await transition(service, application, 'queued', 'queued');
  application = await transition(service, application, 'filling', 'filling');
  return transition(service, application, 'awaiting_confirmation', 'preview', {
    preview_ready: true,
  });
}

describe('ApplicationsService state and evidence', () => {
  it('persists business state across service instances through the injected store', async () => {
    const store = new InMemoryApplicationsStore();
    const firstService = new ApplicationsService(store);
    const created = await create(firstService);

    const restartedService = new ApplicationsService(store);
    const transitioned = await transition(
      restartedService,
      created,
      'materials_ready',
      'after-restart',
    );

    expect(await restartedService.getApplication(USER_ID, created.id)).toEqual(transitioned);
    expect(await restartedService.listApplications(USER_ID)).toHaveLength(1);
    expect(await restartedService.getAuditEvents(USER_ID)).toHaveLength(2);
  });

  it('allows only contracted transitions and replays an identical transition once', async () => {
    const service = new ApplicationsService(new InMemoryApplicationsStore());
    const application = await create(service);

    await expect(transition(service, application, 'submitted', 'illegal')).rejects.toThrowError(
      ApplicationError,
    );
    const first = await transition(service, application, 'materials_ready', 'ready');
    const replay = await service.transitionApplication(
      USER_ID,
      application.id,
      { to_status: 'materials_ready', reason_code: 'move_to_materials_ready' },
      { ...context('ready'), expected_version: application.version, prerequisites: {} },
    );

    expect(replay).toEqual(first);
    expect((await service.getApplication(USER_ID, application.id)).timeline).toHaveLength(2);
    await expectErrorCode(
      () =>
        service.transitionApplication(
          USER_ID,
          application.id,
          { to_status: 'materials_ready', reason_code: 'different_reason' },
          { ...context('ready'), expected_version: application.version },
        ),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('never marks submission successful without verifiable third-party evidence', async () => {
    const service = new ApplicationsService(new InMemoryApplicationsStore());
    let application = await reachAwaitingConfirmation(service);
    application = await transition(
      service,
      application,
      'submitted_pending_verification',
      'submit',
      {
        confirmation_verified: true,
      },
    );

    await expectErrorCode(
      () => transition(service, application, 'submitted', 'no-evidence'),
      'EVIDENCE_REQUIRED',
    );
    expect((await service.getApplication(USER_ID, application.id)).status).toBe(
      'submitted_pending_verification',
    );
    await expectErrorCode(
      () =>
        service.transitionApplication(
          USER_ID,
          application.id,
          {
            to_status: 'submitted',
            reason_code: 'manual_claim_only',
            evidence: [
              {
                type: 'manual_attestation',
                reference: 'I clicked submit',
                captured_at: '2026-07-31T06:00:00.000Z',
                target_origin: 'https://boards.example.test/',
                verified: true,
              },
            ],
          },
          { ...context('manual-only'), expected_version: application.version },
        ),
      'EVIDENCE_REQUIRED',
    );

    const submitted = await service.transitionApplication(
      USER_ID,
      application.id,
      {
        to_status: 'submitted',
        reason_code: 'confirmation_verified',
        evidence: [
          {
            type: 'confirmation_number',
            reference: 'ATS-1042',
            captured_at: '2026-07-31T06:01:00.000Z',
            target_origin: 'https://boards.example.test/',
            verified: true,
          },
        ],
      },
      { ...context('verified'), expected_version: application.version },
    );
    expect(submitted.status).toBe('submitted');
    expect(submitted.timeline.at(-1)).toMatchObject({
      from_status: 'submitted_pending_verification',
      to_status: 'submitted',
    });
  });

  it('records agent receipts idempotently and leaves uncertain submissions pending', async () => {
    const service = new ApplicationsService(new InMemoryApplicationsStore());
    const awaiting = await reachAwaitingConfirmation(service);
    const receipt = {
      receipt_id: randomUUID(),
      agent_id: AGENT_ID,
      command_id: randomUUID(),
      sequence: 1,
      application_id: awaiting.id,
      command_type: 'submit_application' as const,
      status: 'completed' as const,
      occurred_at: '2026-07-31T06:05:00.000Z',
      confirmation_verified: true,
    };

    const first = await service.recordAgentReceipt(USER_ID, receipt);
    const replay = await service.recordAgentReceipt(USER_ID, receipt);
    expect(replay).toEqual(first);
    expect(first.application.status).toBe('submitted_pending_verification');
    expect((await service.getApplication(USER_ID, awaiting.id)).timeline).toHaveLength(7);

    const verified = await service.recordAgentReceipt(USER_ID, {
      ...receipt,
      receipt_id: randomUUID(),
      sequence: 2,
      result_verified: true,
      target_origin: 'https://boards.example.test/',
      result: { confirmation_number: 'ATS-2001' },
    });
    expect(verified.application.status).toBe('submitted');
    await expectErrorCode(
      () =>
        service.recordAgentReceipt(USER_ID, {
          ...receipt,
          receipt_id: randomUUID(),
          status: 'rejected',
        }),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('builds a reference-only manual task package and filters the board', async () => {
    const service = new ApplicationsService(new InMemoryApplicationsStore());
    let application = await create(service);
    application = await transition(service, application, 'materials_ready', 'ready');
    application = await transition(service, application, 'approved', 'approved', {
      materials_approved: true,
      no_open_must_fix: true,
    });
    application = await transition(service, application, 'queued', 'queued');
    application = await transition(service, application, 'filling', 'filling');

    const task = await service.createManualTask(
      USER_ID,
      application.id,
      {
        target_url: 'https://boards.example.test/jobs/42',
        material_refs: [{ type: 'material', id: MATERIAL_ID, version: 2 }],
        answer_refs: [
          {
            field: 'work_authorization',
            answer_ref: { type: 'fact', id: randomUUID(), version: 1 },
          },
        ],
        risk_codes: ['unknown_required_field'],
        unresolved_items: ['Confirm the newly introduced required field'],
        manual_reason: 'unknown_required_field',
        recovery_action: 'user_answer_required',
      },
      { ...context('manual-task'), expected_version: application.version },
    );

    expect(task).toMatchObject({
      type: 'manual_application',
      status: 'requires_human',
      manual_reason: 'unknown_required_field',
    });
    expect(JSON.stringify(task)).not.toMatch(/password|cookie|captcha_value/i);
    expect(await service.getBoard(USER_ID, { has_manual_task: true })).toMatchObject({ total: 1 });
    expect((await service.getApplication(USER_ID, application.id)).status).toBe('manual_required');
  });
});
