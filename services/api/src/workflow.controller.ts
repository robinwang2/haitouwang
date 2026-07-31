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

import { MaterialsError, MaterialsService } from './modules/materials';
import type { Fact } from './modules/profile';
import { AuthService, type AuthenticatedPrincipal } from './auth.service';

interface ApproveMaterialBody {
  expected_version: number;
  facts: Fact[];
  evaluated_at: string;
  goal_id?: string;
  review_id?: string;
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
    @Body() body: ApproveMaterialBody,
  ) {
    const principal = this.auth.authenticate(authorization);
    if (!principal) {
      this.materials.recordApprovalGateFailure('anonymous', materialId, 'UNAUTHENTICATED');
      throw httpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    }
    this.requirePermission(principal, 'material:approve', materialId);
    return this.execute(() =>
      this.materials.approve(
        principal.userId,
        materialId,
        body.expected_version,
        body.facts,
        body.evaluated_at,
        body.goal_id,
        body.review_id,
      ),
    );
  }

  @Post('materials/:materialId/reject')
  @HttpCode(200)
  public rejectMaterial(
    @Headers('authorization') authorization: string | undefined,
    @Param('materialId') materialId: string,
    @Body() body: RejectMaterialBody,
  ) {
    const principal = this.auth.authenticate(authorization);
    if (!principal) {
      this.materials.recordRejectionGateFailure('anonymous', materialId, 'UNAUTHENTICATED');
      throw httpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    }
    if (!principal.permissions.includes('material:approve')) {
      this.materials.recordRejectionGateFailure(principal.userId, materialId, 'FORBIDDEN');
      throw httpError(403, 'FORBIDDEN', 'The authenticated principal cannot reject materials.');
    }
    return this.execute(() =>
      this.materials.reject(principal.userId, materialId, body.expected_version),
    );
  }

  @Get('audit-events')
  public listAudit(
    @Headers('authorization') authorization: string | undefined,
    @Query('resource_id') resourceId?: string,
  ) {
    const principal = this.requirePrincipal(authorization);
    const items = this.materials
      .getAuditEvents(principal.userId)
      .filter((event) => resourceId === undefined || event.material_id === resourceId)
      .map((event) => ({
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
        page_size: Math.max(items.length, 1),
        next_cursor: null,
        total_estimate: items.length,
      },
    };
  }

  private requirePrincipal(authorization: string | undefined): AuthenticatedPrincipal {
    const principal = this.auth.authenticate(authorization);
    if (!principal) throw httpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    return principal;
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
            : error.code.startsWith('REVIEW_') || error.code === 'MATERIAL_NOT_PUBLISHABLE'
              ? 412
              : 409;
      throw httpError(status, error.code, error.message);
    }
  }
}

function httpError(status: number, code: string, message: string): HttpException {
  return new HttpException({ error: { code, message } }, status);
}
