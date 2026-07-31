const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, test } = require('node:test');

const {
  ApplicationError,
  ApplicationsService,
} = require('../../../services/api/dist/modules/applications');
const {
  ReportingError,
  ReportingService,
} = require('../../../services/api/dist/modules/reporting');

const NOW = new Date('2026-07-31T20:00:00.000Z');
const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const JOB_ID = '20000000-0000-4000-8000-000000000001';
const GOAL_ID = '30000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '40000000-0000-4000-8000-000000000001';
const FACT_ID = '45000000-0000-4000-8000-000000000001';
const AGENT_ID = '50000000-0000-4000-8000-000000000001';

function mutationContext(key, application) {
  return {
    actor: { type: 'user', id: USER_ID },
    idempotency_key: `mvp-acceptance:${key}`,
    ...(application ? { expected_version: application.version } : {}),
  };
}

function createApplication(service, suffix) {
  return service.createApplication(
    USER_ID,
    {
      job_id: JOB_ID,
      goal_id: GOAL_ID,
      material_ids: [MATERIAL_ID],
      submission_idempotency_key: `mvp-submission:${suffix.padStart(4, '0')}`,
      deadline_at: '2026-08-02T12:00:00.000Z',
    },
    mutationContext(`create:${suffix}`),
  );
}

function transition(service, application, toStatus, key, prerequisites = {}) {
  return service.transitionApplication(
    USER_ID,
    application.id,
    { to_status: toStatus, reason_code: `mvp_${toStatus}` },
    { ...mutationContext(key, application), prerequisites },
  );
}

function reachFilling(service, suffix) {
  let application = createApplication(service, suffix);
  application = transition(service, application, 'materials_ready', `${suffix}:materials-ready`);
  application = transition(service, application, 'approved', `${suffix}:approved`, {
    materials_approved: true,
    no_open_must_fix: true,
  });
  application = transition(service, application, 'queued', `${suffix}:queued`);
  return transition(service, application, 'filling', `${suffix}:filling`);
}

function receipt(application, sequence, overrides = {}) {
  return {
    receipt_id: randomUUID(),
    agent_id: AGENT_ID,
    command_id: randomUUID(),
    sequence,
    application_id: application.id,
    command_type: 'fill_application',
    status: 'completed',
    occurred_at: NOW.toISOString(),
    ...overrides,
  };
}

function expectCode(action, ErrorType, code) {
  assert.throws(action, (error) => error instanceof ErrorType && error.code === code);
}

describe('MVP application-to-report main path', () => {
  test('approved material, local preview, explicit confirmation and verified evidence produce one traceable submission', () => {
    const applications = new ApplicationsService({ clock: { now: () => NOW } });
    const reporting = new ReportingService({ clock: { now: () => NOW } });
    let application = reachFilling(applications, 'main');

    const fillReceipt = receipt(application, 1, {
      result: { preview_hash: 'a'.repeat(64) },
    });
    const filled = applications.recordAgentReceipt(USER_ID, fillReceipt);
    const replay = applications.recordAgentReceipt(USER_ID, fillReceipt);
    assert.deepEqual(replay, filled);
    assert.equal(filled.application.status, 'awaiting_confirmation');

    const submitted = applications.recordAgentReceipt(
      USER_ID,
      receipt(filled.application, 2, {
        command_type: 'submit_application',
        confirmation_verified: true,
        result_verified: true,
        target_origin: 'https://boards.greenhouse.io/',
        result: { confirmation_number: 'GH-MVP-1001' },
      }),
    ).application;

    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.evidence.length, 1);
    assert.match(submitted.evidence[0].reference, /^GH-MVP-/);
    assert.deepEqual(
      submitted.timeline.map((entry) => entry.to_status),
      [
        'draft',
        'materials_ready',
        'approved',
        'queued',
        'filling',
        'awaiting_confirmation',
        'submitted_pending_verification',
        'submitted',
      ],
    );

    const source = reporting.recordSource({
      record_id: randomUUID(),
      user_id: USER_ID,
      category: 'submitted',
      source_ref: { type: 'application', id: submitted.id, version: submitted.version },
      occurred_at: NOW.toISOString(),
    });
    const notification = reporting.requestNotification(USER_ID, {
      type: 'daily_report',
      dedupe_key: `submitted:${submitted.id}`,
      channel: 'in_app',
      source_ref: source.source_ref,
    });
    assert.equal(reporting.markNotificationSent(USER_ID, notification.id).status, 'sent');

    const report = reporting.generateDailyReport(USER_ID, '2026-07-31', 'UTC');
    assert.equal(report.sections.submitted.count, 1);
    assert.equal(report.source_record_count, 1);
    assert.deepEqual(reporting.getReportSourceRecords(USER_ID, report.id), [source]);
    assert.equal(applications.getBoard(USER_ID).total, 1);
    assert.ok(
      applications
        .getAuditEvents(USER_ID)
        .some((event) => event.action === 'application.agent_receipt_recorded'),
    );
  });
});

describe('MVP manual degradation and recovery', () => {
  test('CAPTCHA pauses automation, creates a reference-only handoff and can resume only through the legal state path', () => {
    const applications = new ApplicationsService({ clock: { now: () => NOW } });
    let application = reachFilling(applications, 'manual');

    application = applications.recordAgentReceipt(
      USER_ID,
      receipt(application, 1, {
        status: 'manual_intervention_required',
        manual_reason: 'captcha',
      }),
    ).application;
    assert.equal(application.status, 'manual_required');
    assert.equal(application.manual_reason, 'captcha');

    const task = applications.createManualTask(
      USER_ID,
      application.id,
      {
        target_url: 'https://boards.greenhouse.io/acme/jobs/42',
        material_refs: [{ type: 'material', id: MATERIAL_ID, version: 2 }],
        answer_refs: [
          {
            field: 'work_authorization',
            answer_ref: { type: 'fact', id: FACT_ID, version: 1 },
          },
        ],
        risk_codes: ['captcha'],
        unresolved_items: ['Complete the CAPTCHA in the local browser.'],
        manual_reason: 'captcha',
        recovery_action: 'user_complete_locally',
      },
      mutationContext('manual:create-task', application),
    );
    assert.equal(task.status, 'requires_human');
    assert.equal(task.max_attempts, 1);
    assert.doesNotMatch(
      JSON.stringify(task),
      /"(?:password|cookie|authorization_header|captcha_value|access_token|refresh_token)"/i,
    );

    application = transition(applications, application, 'filling', 'manual:resume-filling');
    application = applications.recordAgentReceipt(
      USER_ID,
      receipt(application, 2, { result: { preview_hash: 'b'.repeat(64) } }),
    ).application;
    assert.equal(application.status, 'awaiting_confirmation');

    const recovered = applications.recordAgentReceipt(
      USER_ID,
      receipt(application, 3, {
        command_type: 'submit_application',
        confirmation_verified: true,
        result_verified: true,
        target_origin: 'https://boards.greenhouse.io/',
        result: { confirmation_number: 'GH-RECOVERED-1001' },
      }),
    ).application;
    assert.equal(recovered.status, 'submitted');
    assert.equal(applications.listManualTasks(USER_ID, recovered.id).length, 1);
    assert.ok(recovered.timeline.some((entry) => entry.to_status === 'manual_required'));
  });

  test('uncertain submission never retries or becomes successful without third-party evidence', () => {
    const applications = new ApplicationsService({ clock: { now: () => NOW } });
    let application = reachFilling(applications, 'uncertain');
    application = applications.recordAgentReceipt(
      USER_ID,
      receipt(application, 1, { result: { preview_hash: 'c'.repeat(64) } }),
    ).application;
    application = applications.recordAgentReceipt(
      USER_ID,
      receipt(application, 2, {
        command_type: 'submit_application',
        confirmation_verified: true,
      }),
    ).application;

    assert.equal(application.status, 'submitted_pending_verification');
    assert.equal(application.evidence.length, 0);
    expectCode(
      () => transition(applications, application, 'submitted', 'uncertain:no-evidence'),
      ApplicationError,
      'EVIDENCE_REQUIRED',
    );
    assert.equal(
      applications.getApplication(USER_ID, application.id).status,
      'submitted_pending_verification',
    );
  });
});

describe('MVP authorization and release boundary', () => {
  test('cross-tenant application, audit, notification and report access disclose no resource', () => {
    const applications = new ApplicationsService({ clock: { now: () => NOW } });
    const reporting = new ReportingService({ clock: { now: () => NOW } });
    const application = createApplication(applications, 'tenant');
    const notification = reporting.requestNotification(USER_ID, {
      type: 'review_required',
      dedupe_key: `review:${application.id}`,
      channel: 'in_app',
      source_ref: { type: 'application', id: application.id, version: application.version },
    });
    reporting.recordSource({
      record_id: randomUUID(),
      user_id: USER_ID,
      category: 'pending_confirmation',
      source_ref: { type: 'application', id: application.id, version: application.version },
      occurred_at: NOW.toISOString(),
    });
    const report = reporting.generateDailyReport(USER_ID, '2026-07-31', 'UTC');

    expectCode(
      () => applications.getApplication(OTHER_USER_ID, application.id),
      ApplicationError,
      'RESOURCE_NOT_FOUND',
    );
    assert.deepEqual(applications.listApplications(OTHER_USER_ID), []);
    assert.deepEqual(applications.getAuditEvents(OTHER_USER_ID), []);
    expectCode(
      () => reporting.buildDeliveryPayload(OTHER_USER_ID, notification.id),
      ReportingError,
      'RESOURCE_NOT_FOUND',
    );
    expectCode(
      () => reporting.getReportSourceRecords(OTHER_USER_ID, report.id),
      ReportingError,
      'RESOURCE_NOT_FOUND',
    );
    assert.deepEqual(reporting.listNotifications(OTHER_USER_ID), []);
  });

  test('release manifest keeps unresolved production risks behind a fail-closed deployment gate', () => {
    const manifestPath = join(__dirname, '../../../infra/release/release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.candidate_kind, 'non-production-validation');
    assert.equal(manifest.production_authorized, false);
    assert.ok(manifest.blockers.length > 0);
    assert.ok(manifest.blockers.every((blocker) => blocker.control === 'block-production-release'));
    assert.ok(manifest.required_evidence.every((gate) => gate.command && gate.expected));
  });
});
