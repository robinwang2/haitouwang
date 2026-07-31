import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { ApplicationError } from './applications.errors';
import type {
  Actor,
  AgentApplicationReceipt,
  Application,
  ApplicationAuditEvent,
  ApplicationBoard,
  ApplicationListFilter,
  ApplicationServiceOptions,
  ApplicationStatus,
  ApplicationTransitionRequest,
  CreateApplicationRequest,
  CreateManualTaskRequest,
  ManualApplicationTask,
  MutationContext,
  RecordedApplicationReceipt,
  ResourceRef,
  SubmissionEvidence,
  TransitionContext,
} from './applications.types';

export const APPLICATION_SERVICE_OPTIONS = Symbol('APPLICATION_SERVICE_OPTIONS');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/;
const REASON_PATTERN = /^.{1,128}$/u;

const TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  draft: ['materials_ready'],
  materials_ready: ['approved'],
  approved: ['queued'],
  queued: ['filling', 'cancelled'],
  filling: ['awaiting_confirmation', 'manual_required', 'cancelled'],
  awaiting_confirmation: ['submitted_pending_verification', 'manual_required', 'cancelled'],
  submitted_pending_verification: ['submitted', 'manual_required'],
  manual_required: ['filling', 'awaiting_confirmation', 'cancelled'],
  submitted: ['interview', 'rejected', 'offer', 'withdrawn'],
  interview: ['interview', 'rejected', 'offer', 'withdrawn'],
  rejected: [],
  offer: ['withdrawn'],
  withdrawn: [],
  cancelled: [],
};

const STATUS_ORDER: readonly ApplicationStatus[] = [
  'draft',
  'materials_ready',
  'approved',
  'queued',
  'filling',
  'awaiting_confirmation',
  'submitted_pending_verification',
  'manual_required',
  'submitted',
  'interview',
  'rejected',
  'offer',
  'withdrawn',
  'cancelled',
];

interface IdempotencyRecord<T> {
  request_hash: string;
  response: T;
  audit_event_id: string;
}

interface ReceiptRecord {
  request_hash: string;
  response: RecordedApplicationReceipt;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

@Injectable()
export class ApplicationsService {
  private readonly clock: { now(): Date };
  private readonly idFactory: () => string;
  private readonly applications = new Map<string, Application>();
  private readonly submissionKeys = new Map<string, string>();
  private readonly manualTasks = new Map<string, ManualApplicationTask>();
  private readonly idempotency = new Map<string, IdempotencyRecord<unknown>>();
  private readonly receipts = new Map<string, ReceiptRecord>();
  private readonly audit: ApplicationAuditEvent[] = [];

  public constructor(
    @Optional()
    @Inject(APPLICATION_SERVICE_OPTIONS)
    options: ApplicationServiceOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.idFactory = options.id_factory ?? randomUUID;
  }

  public createApplication(
    userId: string,
    input: CreateApplicationRequest,
    context: MutationContext,
  ): Application {
    this.validateIdentity(userId, context);
    this.validateCreate(input);
    return this.mutate<Application>(
      userId,
      'createApplication',
      input,
      context,
      () => {
        const businessKey = `${userId}:${input.submission_idempotency_key}`;
        const existingId = this.submissionKeys.get(businessKey);
        if (existingId) {
          const existing = this.applications.get(existingId);
          if (existing && this.sameApplicationIntent(existing, input)) return clone(existing);
          throw new ApplicationError(
            'CONFLICT',
            'submission_idempotency_key is already assigned to another application intent.',
            409,
          );
        }

        const now = this.now();
        const id = this.idFactory();
        const application: Application = {
          id,
          user_id: userId,
          job_id: input.job_id,
          goal_id: input.goal_id,
          material_ids: [...input.material_ids],
          status: 'draft',
          submission_idempotency_key: input.submission_idempotency_key,
          evidence: [],
          timeline: [
            {
              id: this.idFactory(),
              from_status: null,
              to_status: 'draft',
              actor: clone(context.actor),
              occurred_at: now,
              reason_code: 'application_created',
            },
          ],
          ...(input.deadline_at ? { deadline_at: input.deadline_at } : {}),
          version: 1,
          created_at: now,
          updated_at: now,
        };
        this.applications.set(id, clone(application));
        this.submissionKeys.set(businessKey, id);
        return application;
      },
      (application) => ({
        actor: context.actor,
        action: 'application.created',
        resource: { type: 'application', id: application.id, version: application.version },
        outcome: 'succeeded',
        to_status: 'draft',
      }),
    );
  }

  public getApplication(userId: string, applicationId: string): Application {
    return clone(this.requireApplication(userId, applicationId));
  }

  public listApplications(userId: string, filter: ApplicationListFilter = {}): Application[] {
    this.validateUuid(userId, 'user_id');
    if (filter.due_before) this.validateTimestamp(filter.due_before, 'due_before');
    if (filter.overdue_at) this.validateTimestamp(filter.overdue_at, 'overdue_at');
    const manualApplicationIds = new Set(
      [...this.manualTasks.values()]
        .filter((task) => task.user_id === userId && task.status === 'requires_human')
        .map((task) => task.resource.id),
    );

    return [...this.applications.values()]
      .filter((application) => application.user_id === userId)
      .filter(
        (application) => !filter.statuses?.length || filter.statuses.includes(application.status),
      )
      .filter((application) => !filter.job_id || application.job_id === filter.job_id)
      .filter((application) => !filter.goal_id || application.goal_id === filter.goal_id)
      .filter(
        (application) =>
          !filter.due_before ||
          (application.deadline_at !== undefined && application.deadline_at <= filter.due_before),
      )
      .filter(
        (application) =>
          !filter.overdue_at ||
          (application.deadline_at !== undefined &&
            application.deadline_at < filter.overdue_at &&
            !isApplicationFinished(application.status)),
      )
      .filter(
        (application) =>
          filter.has_manual_task === undefined ||
          manualApplicationIds.has(application.id) === filter.has_manual_task,
      )
      .sort(compareApplications)
      .map(clone);
  }

  public getBoard(userId: string, filter: ApplicationListFilter = {}): ApplicationBoard {
    const applications = this.listApplications(userId, filter);
    return {
      columns: STATUS_ORDER.map((status) => ({
        status,
        applications: applications.filter((application) => application.status === status),
      })),
      total: applications.length,
    };
  }

  public transitionApplication(
    userId: string,
    applicationId: string,
    request: ApplicationTransitionRequest,
    context: TransitionContext,
  ): Application {
    this.validateIdentity(userId, context);
    this.validateTransitionRequest(request);
    return this.mutate<Application>(
      userId,
      `transitionApplication:${applicationId}`,
      { applicationId, request, expected_version: context.expected_version },
      context,
      () => {
        const current = this.requireApplication(userId, applicationId);
        this.assertVersion(current.version, context.expected_version);
        return this.applyTransition(current, request, context.actor, context.prerequisites);
      },
      (application) => {
        const latest = application.timeline.at(-1);
        return {
          actor: context.actor,
          action: 'application.state_changed',
          resource: { type: 'application', id: application.id, version: application.version },
          outcome: application.status === 'manual_required' ? 'manual_intervention' : 'succeeded',
          from_status: latest?.from_status,
          to_status: application.status,
          reason_code: request.reason_code,
        };
      },
    );
  }

  public recordAgentReceipt(
    userId: string,
    receipt: AgentApplicationReceipt,
  ): RecordedApplicationReceipt {
    this.validateUuid(userId, 'user_id');
    this.validateReceipt(receipt);
    const receiptKey = `${receipt.agent_id}:${receipt.command_id}:${receipt.sequence}`;
    const hash = requestHash(receipt);
    const prior = this.receipts.get(receiptKey);
    if (prior) {
      if (prior.request_hash !== hash) {
        throw new ApplicationError(
          'IDEMPOTENCY_KEY_REUSED',
          'The agent command receipt sequence was reused with different content.',
          409,
        );
      }
      return clone(prior.response);
    }

    let application = this.requireApplication(userId, receipt.application_id);
    const actor: Actor = { type: 'agent', id: receipt.agent_id };
    if (receipt.status === 'manual_intervention_required') {
      if (!receipt.manual_reason) {
        throw new ApplicationError(
          'VALIDATION_FAILED',
          'manual_reason is required for a manual intervention receipt.',
          400,
        );
      }
      if (TRANSITIONS[application.status].includes('manual_required')) {
        application = this.applyTransition(
          application,
          {
            to_status: 'manual_required',
            reason_code: 'agent_manual_intervention',
            manual_reason: receipt.manual_reason,
          },
          actor,
        );
      }
    } else if (receipt.status === 'completed') {
      application = this.applyCompletedReceipt(application, receipt, actor);
    }

    const response: RecordedApplicationReceipt = {
      receipt_id: receipt.receipt_id,
      application: clone(application),
      replayed: false,
    };
    this.receipts.set(receiptKey, { request_hash: hash, response: clone(response) });
    this.appendAudit({
      actor,
      action: 'application.agent_receipt_recorded',
      resource: { type: 'application', id: application.id, version: application.version },
      outcome:
        receipt.status === 'manual_intervention_required' ? 'manual_intervention' : 'succeeded',
      to_status: application.status,
      reason_code: receipt.status,
    });
    return response;
  }

  public createManualTask(
    userId: string,
    applicationId: string,
    request: CreateManualTaskRequest,
    context: TransitionContext,
  ): ManualApplicationTask {
    this.validateIdentity(userId, context);
    this.validateManualTask(request);
    return this.mutate<ManualApplicationTask>(
      userId,
      `createManualTask:${applicationId}`,
      { applicationId, request, expected_version: context.expected_version },
      context,
      () => {
        let application = this.requireApplication(userId, applicationId);
        this.assertVersion(application.version, context.expected_version);
        if (application.status !== 'manual_required') {
          if (!TRANSITIONS[application.status].includes('manual_required')) {
            throw new ApplicationError(
              'STATE_TRANSITION_INVALID',
              'A manual task cannot be created from the current application state.',
              409,
            );
          }
          application = this.applyTransition(
            application,
            {
              to_status: 'manual_required',
              reason_code: 'manual_task_created',
              manual_reason: request.manual_reason,
            },
            context.actor,
          );
        }
        const now = this.now();
        const task: ManualApplicationTask = {
          id: this.idFactory(),
          user_id: userId,
          type: 'manual_application',
          status: 'requires_human',
          resource: { type: 'application', id: application.id, version: application.version },
          attempt: 0,
          max_attempts: 1,
          manual_reason: request.manual_reason,
          package: {
            target_url: request.target_url,
            material_refs: clone(request.material_refs),
            answer_refs: clone(request.answer_refs),
            risk_codes: [...request.risk_codes],
            unresolved_items: [...request.unresolved_items],
            recovery_action: request.recovery_action,
            ...((request.deadline_at ?? application.deadline_at)
              ? { deadline_at: request.deadline_at ?? application.deadline_at }
              : {}),
          },
          created_at: now,
          updated_at: now,
        };
        this.manualTasks.set(task.id, clone(task));
        return task;
      },
      (task) => ({
        actor: context.actor,
        action: 'application.manual_task_created',
        resource: { type: 'task', id: task.id },
        outcome: 'manual_intervention',
        reason_code: request.manual_reason,
      }),
    );
  }

  public listManualTasks(userId: string, applicationId?: string): ManualApplicationTask[] {
    this.validateUuid(userId, 'user_id');
    return [...this.manualTasks.values()]
      .filter(
        (task) => task.user_id === userId && (!applicationId || task.resource.id === applicationId),
      )
      .sort((left, right) =>
        `${left.created_at}:${left.id}`.localeCompare(`${right.created_at}:${right.id}`),
      )
      .map(clone);
  }

  public getAuditEvents(userId: string): ApplicationAuditEvent[] {
    this.validateUuid(userId, 'user_id');
    const applicationIds = new Set(
      [...this.applications.values()]
        .filter((application) => application.user_id === userId)
        .map((application) => application.id),
    );
    const taskIds = new Set(
      [...this.manualTasks.values()]
        .filter((task) => task.user_id === userId)
        .map((task) => task.id),
    );
    return this.audit
      .filter(
        (event) =>
          (event.resource.type === 'application' && applicationIds.has(event.resource.id)) ||
          (event.resource.type === 'task' && taskIds.has(event.resource.id)),
      )
      .map(clone);
  }

  private applyCompletedReceipt(
    current: Application,
    receipt: AgentApplicationReceipt,
    actor: Actor,
  ): Application {
    if (receipt.command_type === 'fill_application') {
      if (current.status === 'filling' && receipt.result?.preview_hash) {
        return this.applyTransition(
          current,
          { to_status: 'awaiting_confirmation', reason_code: 'form_preview_ready' },
          actor,
          { preview_ready: true },
        );
      }
      return current;
    }
    if (receipt.command_type !== 'submit_application') return current;

    let application = current;
    if (application.status === 'awaiting_confirmation') {
      if (!receipt.confirmation_verified) {
        throw new ApplicationError(
          'PRECONDITION_REQUIRED',
          'A verified one-time user confirmation is required before submission.',
          412,
        );
      }
      application = this.applyTransition(
        application,
        {
          to_status: 'submitted_pending_verification',
          reason_code: 'agent_submission_completed',
        },
        actor,
        { confirmation_verified: true },
        true,
      );
    }

    if (application.status !== 'submitted_pending_verification') return application;
    const evidence = this.evidenceFromReceipt(receipt);
    if (!hasVerifiableSubmissionEvidence(evidence)) {
      return application;
    }
    return this.applyTransition(
      application,
      {
        to_status: 'submitted',
        reason_code: 'submission_evidence_verified',
        evidence,
      },
      actor,
    );
  }

  private evidenceFromReceipt(receipt: AgentApplicationReceipt): SubmissionEvidence[] {
    if (!receipt.result_verified || !receipt.target_origin) return [];
    const evidence: SubmissionEvidence[] = [];
    if (receipt.result?.confirmation_number) {
      evidence.push({
        type: 'confirmation_number',
        reference: receipt.result.confirmation_number,
        captured_at: receipt.occurred_at,
        target_origin: receipt.target_origin,
        verified: true,
      });
    }
    if (receipt.result?.evidence_file_id) {
      evidence.push({
        type: 'redacted_screenshot',
        reference: receipt.result.evidence_file_id,
        captured_at: receipt.occurred_at,
        target_origin: receipt.target_origin,
        verified: true,
      });
    }
    return evidence;
  }

  private applyTransition(
    current: Application,
    request: ApplicationTransitionRequest,
    actor: Actor,
    prerequisites: TransitionContext['prerequisites'] = {},
    trustedConfirmation = false,
  ): Application {
    if (!TRANSITIONS[current.status].includes(request.to_status)) {
      throw new ApplicationError(
        'STATE_TRANSITION_INVALID',
        `Transition from ${current.status} to ${request.to_status} is not allowed.`,
        409,
      );
    }
    if (
      current.status === 'materials_ready' &&
      request.to_status === 'approved' &&
      (!prerequisites?.materials_approved || !prerequisites.no_open_must_fix)
    ) {
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'Approved materials and closure of every must-fix finding are required.',
        412,
      );
    }
    if (
      current.status === 'filling' &&
      request.to_status === 'awaiting_confirmation' &&
      !prerequisites?.preview_ready
    ) {
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'A completed form preview is required before confirmation.',
        412,
      );
    }
    if (
      current.status === 'awaiting_confirmation' &&
      request.to_status === 'submitted_pending_verification' &&
      (!prerequisites?.confirmation_verified ||
        (!trustedConfirmation &&
          (!request.confirmation_token || request.confirmation_token.length < 43)))
    ) {
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'A verified one-time user confirmation is required before submission.',
        412,
      );
    }
    const combinedEvidence = mergeEvidence(current.evidence, request.evidence ?? []);
    if (
      current.status === 'submitted_pending_verification' &&
      request.to_status === 'submitted' &&
      !hasVerifiableSubmissionEvidence(combinedEvidence)
    ) {
      throw new ApplicationError(
        'EVIDENCE_REQUIRED',
        'Verified third-party submission evidence is required before marking success.',
        412,
      );
    }
    if (request.to_status === 'manual_required' && !request.manual_reason) {
      throw new ApplicationError(
        'MANUAL_INTERVENTION_REQUIRED',
        'manual_reason is required when automation is degraded to manual handling.',
        422,
      );
    }

    const now = this.now();
    const updated: Application = {
      ...clone(current),
      status: request.to_status,
      evidence: combinedEvidence,
      timeline: [
        ...current.timeline,
        {
          id: this.idFactory(),
          from_status: current.status,
          to_status: request.to_status,
          actor: clone(actor),
          occurred_at: now,
          reason_code: request.reason_code,
          ...timelineEvidenceRef(request.evidence),
        },
      ],
      ...(request.to_status === 'manual_required' && request.manual_reason
        ? { manual_reason: request.manual_reason }
        : {}),
      version: current.version + 1,
      updated_at: now,
    };
    if (request.to_status !== 'manual_required') delete updated.manual_reason;
    this.applications.set(updated.id, clone(updated));
    return updated;
  }

  private mutate<T>(
    userId: string,
    operation: string,
    request: unknown,
    context: MutationContext,
    change: () => T,
    auditFactory: (result: T) => Omit<ApplicationAuditEvent, 'event_id' | 'occurred_at'>,
  ): T {
    const key = `${userId}:${operation}:${context.idempotency_key}`;
    const hash = requestHash(request);
    const prior = this.idempotency.get(key) as IdempotencyRecord<T> | undefined;
    if (prior) {
      if (prior.request_hash !== hash) {
        throw new ApplicationError(
          'IDEMPOTENCY_KEY_REUSED',
          'The idempotency key was already used for a different request.',
          409,
        );
      }
      return clone(prior.response);
    }
    const result = change();
    const event = this.appendAudit(auditFactory(result));
    this.idempotency.set(key, {
      request_hash: hash,
      response: clone(result),
      audit_event_id: event.event_id,
    });
    return clone(result);
  }

  private appendAudit(
    event: Omit<ApplicationAuditEvent, 'event_id' | 'occurred_at'>,
  ): ApplicationAuditEvent {
    const complete: ApplicationAuditEvent = {
      ...clone(event),
      event_id: this.idFactory(),
      occurred_at: this.now(),
    };
    this.audit.push(complete);
    return complete;
  }

  private requireApplication(userId: string, applicationId: string): Application {
    this.validateUuid(applicationId, 'application_id');
    const application = this.applications.get(applicationId);
    if (!application || application.user_id !== userId) {
      throw new ApplicationError('RESOURCE_NOT_FOUND', 'Application was not found.', 404);
    }
    return clone(application);
  }

  private validateCreate(input: CreateApplicationRequest): void {
    this.validateUuid(input.job_id, 'job_id');
    this.validateUuid(input.goal_id, 'goal_id');
    if (
      !Array.isArray(input.material_ids) ||
      input.material_ids.length < 1 ||
      input.material_ids.length > 20 ||
      new Set(input.material_ids).size !== input.material_ids.length
    ) {
      throw this.validation('material_ids must contain 1 to 20 unique ids.');
    }
    input.material_ids.forEach((id) => this.validateUuid(id, 'material_id'));
    if (!IDEMPOTENCY_KEY_PATTERN.test(input.submission_idempotency_key)) {
      throw this.validation(
        'submission_idempotency_key must contain 16 to 128 printable ASCII characters.',
      );
    }
    if (input.deadline_at) this.validateTimestamp(input.deadline_at, 'deadline_at');
  }

  private validateTransitionRequest(request: ApplicationTransitionRequest): void {
    if (!STATUS_ORDER.includes(request.to_status)) throw this.validation('to_status is invalid.');
    if (!REASON_PATTERN.test(request.reason_code)) throw this.validation('reason_code is invalid.');
    if (request.evidence && request.evidence.length > 20) {
      throw this.validation('evidence cannot contain more than 20 records.');
    }
    request.evidence?.forEach((evidence) => this.validateEvidence(evidence));
  }

  private validateEvidence(evidence: SubmissionEvidence): void {
    this.validateTimestamp(evidence.captured_at, 'evidence.captured_at');
    this.validateTargetUrl(evidence.target_origin, 'evidence.target_origin');
    if (
      evidence.reference !== undefined &&
      (evidence.reference.length < 1 || evidence.reference.length > 512)
    ) {
      throw this.validation('evidence.reference must contain 1 to 512 characters.');
    }
  }

  private validateManualTask(request: CreateManualTaskRequest): void {
    this.validateTargetUrl(request.target_url, 'target_url');
    if (
      request.material_refs.length < 1 ||
      request.material_refs.some((ref) => ref.type !== 'material')
    ) {
      throw this.validation('material_refs must contain at least one material reference.');
    }
    if (
      request.answer_refs.some(
        (answer) => !answer.field.trim() || answer.answer_ref.type !== 'fact',
      )
    ) {
      throw this.validation('answer_refs must use named fact references.');
    }
    for (const ref of [
      ...request.material_refs,
      ...request.answer_refs.map((answer) => answer.answer_ref),
    ]) {
      this.validateUuid(ref.id, 'resource_ref.id');
    }
    if (request.risk_codes.some((code) => !REASON_PATTERN.test(code))) {
      throw this.validation('risk_codes contains an invalid code.');
    }
    if (request.unresolved_items.some((item) => !item.trim() || item.length > 256)) {
      throw this.validation('unresolved_items contains an invalid item.');
    }
    if (request.deadline_at) this.validateTimestamp(request.deadline_at, 'deadline_at');
  }

  private validateReceipt(receipt: AgentApplicationReceipt): void {
    this.validateUuid(receipt.receipt_id, 'receipt_id');
    this.validateUuid(receipt.agent_id, 'agent_id');
    this.validateUuid(receipt.command_id, 'command_id');
    this.validateUuid(receipt.application_id, 'application_id');
    if (!Number.isInteger(receipt.sequence) || receipt.sequence < 1) {
      throw this.validation('receipt.sequence must be a positive integer.');
    }
    this.validateTimestamp(receipt.occurred_at, 'receipt.occurred_at');
    if (receipt.target_origin) this.validateTargetUrl(receipt.target_origin, 'target_origin');
  }

  private validateIdentity(userId: string, context: MutationContext): void {
    this.validateUuid(userId, 'user_id');
    if (!context?.actor?.id || !context.actor.type) throw this.validation('actor is required.');
    if (context.actor.type === 'user' && context.actor.id !== userId) {
      throw this.validation('A user actor must match the authenticated user.');
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(context.idempotency_key)) {
      throw this.validation('idempotency_key must contain 16 to 128 printable ASCII characters.');
    }
  }

  private validateTargetUrl(value: string, field: string): void {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
    } catch {
      throw this.validation(`${field} must be a credential-free HTTP(S) URL.`);
    }
  }

  private validateTimestamp(value: string, field: string): void {
    if (!value || !Number.isFinite(Date.parse(value)))
      throw this.validation(`${field} must be a timestamp.`);
  }

  private validateUuid(value: string, field: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw this.validation(`${field} must be a UUID.`);
    }
  }

  private assertVersion(actual: number, expected: number): void {
    if (!Number.isInteger(expected) || expected < 1)
      throw this.validation('expected_version must be positive.');
    if (actual !== expected) {
      throw new ApplicationError(
        'CONFLICT',
        'Application version does not match expected_version.',
        409,
      );
    }
  }

  private sameApplicationIntent(
    application: Application,
    input: CreateApplicationRequest,
  ): boolean {
    return (
      application.job_id === input.job_id &&
      application.goal_id === input.goal_id &&
      JSON.stringify(application.material_ids) === JSON.stringify(input.material_ids) &&
      application.deadline_at === input.deadline_at
    );
  }

  private validation(message: string): ApplicationError {
    return new ApplicationError('VALIDATION_FAILED', message, 400);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

export function hasVerifiableSubmissionEvidence(evidence: readonly SubmissionEvidence[]): boolean {
  return evidence.some(
    (item) =>
      item.verified &&
      item.type !== 'manual_attestation' &&
      typeof item.reference === 'string' &&
      item.reference.trim().length > 0 &&
      Number.isFinite(Date.parse(item.captured_at)) &&
      isHttpOrigin(item.target_origin),
  );
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function mergeEvidence(
  current: readonly SubmissionEvidence[],
  incoming: readonly SubmissionEvidence[],
): SubmissionEvidence[] {
  const result = new Map<string, SubmissionEvidence>();
  for (const item of [...current, ...incoming]) {
    const key = `${item.type}:${item.reference ?? ''}:${item.captured_at}:${item.target_origin}`;
    result.set(key, clone(item));
  }
  return [...result.values()];
}

function timelineEvidenceRef(evidence: readonly SubmissionEvidence[] | undefined): {
  evidence_ref?: ResourceRef;
} {
  const fileEvidence = evidence?.find(
    (item) =>
      item.type === 'redacted_screenshot' && item.reference && UUID_PATTERN.test(item.reference),
  );
  return fileEvidence?.reference
    ? { evidence_ref: { type: 'file', id: fileEvidence.reference } }
    : {};
}

function compareApplications(left: Application, right: Application): number {
  const leftDeadline = left.deadline_at ?? '9999-12-31T23:59:59.999Z';
  const rightDeadline = right.deadline_at ?? '9999-12-31T23:59:59.999Z';
  return (
    leftDeadline.localeCompare(rightDeadline) ||
    left.updated_at.localeCompare(right.updated_at) ||
    left.id.localeCompare(right.id)
  );
}

function isApplicationFinished(status: ApplicationStatus): boolean {
  return ['submitted', 'interview', 'rejected', 'offer', 'withdrawn', 'cancelled'].includes(status);
}
