import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { MaterialsError, MaterialsService } from './modules/materials';
import type { Fact } from './modules/profile';
import { AuthError, AuthService, type AuthenticatedPrincipal } from './auth.service';

interface ApproveMaterialBody {
  expected_version: number;
  facts: Fact[];
  evaluated_at: string;
  goal_id?: string;
  review_id: string;
}

interface RejectMaterialBody {
  expected_version: number;
}

@Controller('v1')
export class WorkflowController {
  public constructor(
    @Inject(AuthService)
    private readonly auth: AuthService,
    @Inject(MaterialsService)
    private readonly materials: MaterialsService,
  ) {}

  @Get('reviews/:reviewId')
  public getReview(
    @Headers('authorization') authorization: string | undefined,
    @Param('reviewId') reviewId: string,
  ) {
    const principal = this.requirePrincipal(authorization);
    return this.execute(() => this.materials.getReview(principal.userId, reviewId));
  }

  @Post('reviews/:reviewId/findings/:findingId/resolve')
  @HttpCode(200)
  public resolveFinding(
    @Headers('authorization') authorization: string | undefined,
    @Param('reviewId') reviewId: string,
    @Param('findingId') findingId: string,
  ) {
    const principal = this.requirePrincipal(authorization);
    this.requirePermission(principal, 'material:approve');
    return this.execute(() =>
      this.materials.resolveReviewFinding(principal.userId, reviewId, findingId),
    );
  }

  @Post('materials/:materialId/approve')
  @HttpCode(200)
  public approveMaterial(
    @Headers('authorization') authorization: string | undefined,
    @Param('materialId') materialId: string,
    @Body() unvalidatedBody: unknown,
  ) {
    const principal = this.authenticateForMaterial(authorization, materialId, 'approval');
    this.requirePermission(principal, 'material:approve', materialId);
    const body = this.validateApprovalBody(unvalidatedBody, principal.userId, materialId);
    return this.execute(() =>
      toContractMaterial(
        this.materials.approve(
          principal.userId,
          materialId,
          body.expected_version,
          body.facts,
          body.evaluated_at,
          body.goal_id,
          body.review_id,
        ),
      ),
    );
  }

  @Post('materials/:materialId/reject')
  @HttpCode(200)
  public rejectMaterial(
    @Headers('authorization') authorization: string | undefined,
    @Param('materialId') materialId: string,
    @Body() unvalidatedBody: unknown,
  ) {
    const principal = this.authenticateForMaterial(authorization, materialId, 'rejection');
    if (!principal.permissions.includes('material:approve')) {
      this.materials.recordRejectionGateFailure(principal.userId, materialId, 'FORBIDDEN');
      throw httpError(403, 'FORBIDDEN', 'The authenticated principal cannot reject materials.');
    }
    const body = validateRejectMaterialBody(unvalidatedBody);
    return this.execute(() =>
      toContractMaterial(
        this.materials.reject(principal.userId, materialId, body.expected_version),
      ),
    );
  }

  @Get('audit-events')
  public listAudit(
    @Headers('authorization') authorization: string | undefined,
    @Query('resource_id') resourceId?: string,
    @Query('cursor') cursor?: string,
    @Query('page_size') requestedPageSize?: string,
  ) {
    const principal = this.requirePrincipal(authorization);
    const pageSize = requestedPageSize === undefined ? 25 : Number(requestedPageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw httpError(400, 'VALIDATION_FAILED', 'page_size must be an integer from 1 to 100.');
    }
    const available = this.materials
      .getAuditEvents(principal.userId)
      .filter((event) => resourceId === undefined || event.material_id === resourceId);
    const cursorIndex = cursor ? available.findIndex((event) => event.event_id === cursor) : -1;
    if (cursor && cursorIndex < 0) {
      throw httpError(400, 'VALIDATION_FAILED', 'cursor is invalid for this audit result set.');
    }
    const start = cursorIndex + 1;
    const page = available.slice(start, start + pageSize);
    const items = page.map((event) => ({
      event_id: event.event_id,
      tenant_id: event.user_id,
      occurred_at: event.occurred_at,
      actor: { type: 'user', id: event.user_id },
      action: event.action,
      resource: {
        type: 'material',
        id: event.material_id,
        ...(event.material_version > 0 ? { version: event.material_version } : {}),
      },
      outcome: event.outcome ?? 'succeeded',
      ...(event.reason_code ? { reason_code: event.reason_code } : {}),
      request_id: event.event_id,
      correlation_id: event.event_id,
      changed_fields: event.changed_fields,
    }));
    return {
      items,
      page: {
        page_size: pageSize,
        next_cursor:
          start + page.length < available.length ? (page.at(-1)?.event_id ?? null) : null,
        total_estimate: available.length,
      },
    };
  }

  private requirePrincipal(authorization: string | undefined): AuthenticatedPrincipal {
    try {
      return this.auth.authenticate(authorization);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      throw httpError(error.code === 'FORBIDDEN' ? 403 : 401, error.code, error.message);
    }
  }

  private authenticateForMaterial(
    authorization: string | undefined,
    materialId: string,
    operation: 'approval' | 'rejection',
  ): AuthenticatedPrincipal {
    try {
      return this.auth.authenticate(authorization);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      const record =
        operation === 'approval'
          ? this.materials.recordApprovalGateFailure.bind(this.materials)
          : this.materials.recordRejectionGateFailure.bind(this.materials);
      record(undefined, materialId, error.code);
      throw httpError(error.code === 'FORBIDDEN' ? 403 : 401, error.code, error.message);
    }
  }

  private validateApprovalBody(
    value: unknown,
    userId: string,
    materialId: string,
  ): ApproveMaterialBody {
    try {
      return validateApproveMaterialBody(value);
    } catch (error) {
      this.materials.recordApprovalGateFailure(userId, materialId, 'VALIDATION_FAILED');
      throw error;
    }
  }

  private requirePermission(
    principal: AuthenticatedPrincipal,
    permission: string,
    resourceId?: string,
  ): void {
    if (!principal.permissions.includes(permission)) {
      if (resourceId) {
        this.materials.recordApprovalGateFailure(principal.userId, resourceId, 'FORBIDDEN');
      }
      throw httpError(403, 'FORBIDDEN', 'The authenticated principal cannot approve materials.');
    }
  }

  private execute<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof MaterialsError)) throw error;
      const status =
        error.code === 'RESOURCE_NOT_FOUND'
          ? 404
          : error.code === 'VALIDATION_FAILED'
            ? 400
            : error.code === 'TRANSACTION_FAILED'
              ? 500
              : error.code.startsWith('REVIEW_') || error.code === 'MATERIAL_NOT_PUBLISHABLE'
                ? 412
                : 409;
      throw httpError(status, publicErrorCode(error.code), error.message);
    }
  }
}

function httpError(status: number, code: string, message: string): HttpException {
  const requestId = randomUUID();
  return new HttpException(
    {
      error: { code, message, retryable: status >= 500 },
      request_id: requestId,
      correlation_id: requestId,
    },
    status,
  );
}

function validateApproveMaterialBody(value: unknown): ApproveMaterialBody {
  if (!isRecord(value)) validationError('Request body must be an object.');
  const allowed = new Set(['expected_version', 'facts', 'evaluated_at', 'goal_id', 'review_id']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    validationError('Request body contains an unsupported field.');
  }
  if (!Number.isInteger(value.expected_version) || Number(value.expected_version) < 1) {
    validationError('expected_version must be a positive integer.');
  }
  if (
    !Array.isArray(value.facts) ||
    value.facts.length > 500 ||
    !value.facts.every(isContractFact)
  ) {
    validationError('facts must contain at most 500 contract-valid Fact objects.');
  }
  if (typeof value.evaluated_at !== 'string' || !Number.isFinite(Date.parse(value.evaluated_at))) {
    validationError('evaluated_at must be an RFC 3339 timestamp.');
  }
  if (!isUuid(value.review_id)) validationError('review_id is required and must be a UUID.');
  if (value.goal_id !== undefined && !isUuid(value.goal_id)) {
    validationError('goal_id must be a UUID when supplied.');
  }
  return value as unknown as ApproveMaterialBody;
}

function validateRejectMaterialBody(value: unknown): RejectMaterialBody {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'expected_version') ||
    !Number.isInteger(value.expected_version) ||
    Number(value.expected_version) < 1
  ) {
    validationError('expected_version must be the only field and a positive integer.');
  }
  return value as unknown as RejectMaterialBody;
}

function validationError(message: string): never {
  throw httpError(400, 'VALIDATION_FAILED', message);
}

function publicErrorCode(code: MaterialsError['code']): string {
  if (code.startsWith('REVIEW_') || code === 'MATERIAL_NOT_PUBLISHABLE') {
    return 'PRECONDITION_REQUIRED';
  }
  if (code === 'FACT_POLICY_VIOLATION') return 'EVIDENCE_REQUIRED';
  if (code === 'TRANSACTION_FAILED') return 'INTERNAL_ERROR';
  return code;
}

function toContractMaterial(material: ReturnType<MaterialsService['get']>) {
  return {
    id: material.id,
    user_id: material.user_id,
    ...(material.job_id ? { job_id: material.job_id } : {}),
    kind: material.kind,
    status: material.status,
    version: material.version,
    file_ids: [...material.file_ids],
    fact_citations: material.fact_citations.map((citation) => ({ ...citation })),
    ...(material.supersedes_id ? { supersedes_id: material.supersedes_id } : {}),
    created_at: material.created_at,
    updated_at: material.updated_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContractFact(value: unknown): value is Fact {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    'id',
    'user_id',
    'kind',
    'value',
    'scope',
    'status',
    'valid_from',
    'valid_until',
    'source',
    'confirmed_at',
    'version',
    'created_at',
    'updated_at',
  ]);
  const kinds = new Set([
    'identity',
    'contact',
    'summary',
    'experience',
    'education',
    'skill',
    'certification',
    'project',
    'work_authorization',
    'preference',
  ]);
  const statuses = new Set([
    'pending_confirmation',
    'active',
    'expired',
    'rejected',
    'revoked',
    'prohibited',
    'deleted',
  ]);
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    !isUuid(value.id) ||
    !isUuid(value.user_id) ||
    typeof value.kind !== 'string' ||
    !kinds.has(value.kind) ||
    !isRecord(value.value) ||
    Object.keys(value.value).length < 1 ||
    Object.keys(value.value).length > 50 ||
    !Object.values(value.value).every(
      (item) =>
        item === null ||
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean',
    ) ||
    !isFactScope(value.scope) ||
    typeof value.status !== 'string' ||
    !statuses.has(value.status) ||
    !isSourceRef(value.source) ||
    !Number.isInteger(value.version) ||
    Number(value.version) < 1 ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at)
  ) {
    return false;
  }
  return (
    (value.valid_from === undefined || isTimestamp(value.valid_from)) &&
    (value.valid_until === undefined || isTimestamp(value.valid_until)) &&
    (value.confirmed_at === undefined || isTimestamp(value.confirmed_at))
  );
}

function isFactScope(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !['use', 'goal_ids'].includes(key))) {
    return false;
  }
  if (
    typeof value.use !== 'string' ||
    !['all_goals', 'selected_goals', 'manual_only', 'prohibited'].includes(value.use)
  ) {
    return false;
  }
  return (
    value.goal_ids === undefined ||
    (Array.isArray(value.goal_ids) &&
      value.goal_ids.length <= 100 &&
      value.goal_ids.every(isUuid) &&
      new Set(value.goal_ids).size === value.goal_ids.length)
  );
}

function isSourceRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ['type', 'reference'].includes(key)) &&
    ['user', 'file', 'system_rule'].includes(String(value.type)) &&
    typeof value.reference === 'string' &&
    value.reference.length >= 1 &&
    value.reference.length <= 512
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
