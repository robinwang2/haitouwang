import { describe, expect, it } from 'vitest';

import {
  InMemoryApplicationsStore,
  type Application,
  type ApplicationAuditEvent,
  type ManualApplicationTask,
} from '../../src/modules/applications';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const NOW = '2026-07-31T12:00:00.000Z';

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: '60000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    job_id: '20000000-0000-4000-8000-000000000001',
    goal_id: '30000000-0000-4000-8000-000000000001',
    material_ids: ['40000000-0000-4000-8000-000000000001'],
    status: 'draft',
    submission_idempotency_key: 'submission-key-0000000000000001',
    evidence: [],
    timeline: [
      {
        id: '70000000-0000-4000-8000-000000000001',
        from_status: null,
        to_status: 'draft',
        actor: { type: 'user', id: USER_ID },
        occurred_at: NOW,
        reason_code: 'application_created',
      },
    ],
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function manualTask(overrides: Partial<ManualApplicationTask> = {}): ManualApplicationTask {
  return {
    id: '80000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    type: 'manual_application',
    status: 'requires_human',
    resource: { type: 'application', id: application().id, version: 1 },
    attempt: 0,
    max_attempts: 1,
    manual_reason: 'captcha',
    package: {
      target_url: 'https://example.com/apply',
      material_refs: [{ type: 'material', id: '40000000-0000-4000-8000-000000000001' }],
      answer_refs: [],
      risk_codes: [],
      unresolved_items: [],
      recovery_action: 'user_complete_locally',
    },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function auditEvent(overrides: Partial<ApplicationAuditEvent> = {}): ApplicationAuditEvent {
  return {
    event_id: '90000000-0000-4000-8000-000000000001',
    occurred_at: NOW,
    actor: { type: 'user', id: USER_ID },
    action: 'application.created',
    resource: { type: 'application', id: application().id, version: 1 },
    outcome: 'succeeded',
    to_status: 'draft',
    ...overrides,
  };
}

describe('InMemoryApplicationsStore', () => {
  it('round-trips an application and enforces tenant scoping on reads', async () => {
    const store = new InMemoryApplicationsStore();
    await store.saveApplication(USER_ID, application());

    expect(await store.getApplication(USER_ID, application().id)).toEqual(application());
    expect(await store.getApplication(OTHER_USER_ID, application().id)).toBeUndefined();
    expect((await store.listApplications(USER_ID)).map((row) => row.id)).toEqual([
      application().id,
    ]);
    expect(await store.listApplications(OTHER_USER_ID)).toEqual([]);
    expect(
      await store.findApplicationIdBySubmissionKey(
        USER_ID,
        application().submission_idempotency_key,
      ),
    ).toBe(application().id);
    expect(
      await store.findApplicationIdBySubmissionKey(
        OTHER_USER_ID,
        application().submission_idempotency_key,
      ),
    ).toBeUndefined();
  });

  it('rejects a second application for the same tenant reusing a submission key', async () => {
    const store = new InMemoryApplicationsStore();
    await store.saveApplication(USER_ID, application());
    const secondIntent = application({
      id: '60000000-0000-4000-8000-000000000002',
      goal_id: '30000000-0000-4000-8000-000000000002',
    });

    await expect(store.saveApplication(USER_ID, secondIntent)).rejects.toThrow();
  });

  it('scopes manual tasks by tenant and optional application id', async () => {
    const store = new InMemoryApplicationsStore();
    await store.saveManualTask(USER_ID, manualTask());
    await store.saveManualTask(
      USER_ID,
      manualTask({
        id: '80000000-0000-4000-8000-000000000002',
        resource: { type: 'application', id: '60000000-0000-4000-8000-000000000099', version: 1 },
      }),
    );

    expect((await store.listManualTasks(USER_ID)).map((task) => task.id)).toHaveLength(2);
    expect((await store.listManualTasks(USER_ID, application().id)).map((task) => task.id)).toEqual(
      [manualTask().id],
    );
    expect(await store.listManualTasks(OTHER_USER_ID)).toEqual([]);
  });

  it('round-trips idempotency records scoped by user, operation and key', async () => {
    const store = new InMemoryApplicationsStore();
    const record = {
      request_hash: 'hash-1',
      response: { ok: true },
      audit_event_id: auditEvent().event_id,
    };
    await store.saveIdempotencyRecord(USER_ID, 'createApplication', 'key-1', record);

    expect(await store.getIdempotencyRecord(USER_ID, 'createApplication', 'key-1')).toEqual(record);
    expect(
      await store.getIdempotencyRecord(OTHER_USER_ID, 'createApplication', 'key-1'),
    ).toBeUndefined();
    expect(await store.getIdempotencyRecord(USER_ID, 'createApplication', 'key-2')).toBeUndefined();
  });

  it('round-trips receipt records and rejects a duplicate receipt id', async () => {
    const store = new InMemoryApplicationsStore();
    const receiptId = 'a0000000-0000-4000-8000-000000000001';
    const record = {
      receipt_id: receiptId,
      request_hash: 'hash-1',
      response: { receipt_id: receiptId, application: application(), replayed: false },
    };
    await store.saveReceipt(USER_ID, 'agent:command:1', record);

    expect(await store.getReceipt(USER_ID, 'agent:command:1')).toEqual(record);
    expect(await store.getReceipt(OTHER_USER_ID, 'agent:command:1')).toBeUndefined();
    await expect(store.saveReceipt(USER_ID, 'agent:command:2', record)).rejects.toThrow();
    await expect(
      store.saveReceipt(OTHER_USER_ID, 'agent:command:2', record),
    ).resolves.toBeUndefined();
  });

  it('scopes audit events by tenant', async () => {
    const store = new InMemoryApplicationsStore();
    await store.appendAuditEvent(USER_ID, auditEvent());
    await store.appendAuditEvent(
      OTHER_USER_ID,
      auditEvent({ event_id: '90000000-0000-4000-8000-000000000002' }),
    );

    expect((await store.listAuditEvents(USER_ID)).map((event) => event.event_id)).toEqual([
      auditEvent().event_id,
    ]);
    expect((await store.listAuditEvents(OTHER_USER_ID)).map((event) => event.event_id)).toEqual([
      '90000000-0000-4000-8000-000000000002',
    ]);
  });

  it('commits writes performed inside withTransaction (single in-process store)', async () => {
    const store = new InMemoryApplicationsStore();
    await store.withTransaction(async (scoped) => {
      await scoped.saveApplication(USER_ID, application());
    });
    expect(await store.getApplication(USER_ID, application().id)).toEqual(application());
  });
});
