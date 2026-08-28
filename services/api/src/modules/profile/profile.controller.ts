import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { BearerAuthGuard } from '../../common/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import { httpError, toHttpException } from '../../common/http-error';
import type { AuthenticatedPrincipal } from '../../auth.service';
import { ProfileError } from './profile.errors';
import { ProfileService } from './profile.service';
import type {
  CreateFactInput,
  CreateGoalInput,
  Fact,
  FactStatus,
  Goal,
  MutationContext,
} from './profile.types';

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FACT_STATUSES = new Set<string>([
  'pending_confirmation',
  'active',
  'expired',
  'rejected',
  'revoked',
  'prohibited',
  'deleted',
]);

interface PageMeta {
  page_size: number;
  next_cursor: string | null;
  total_estimate: number;
}

interface CursorPage<T> {
  items: T[];
  page: PageMeta;
}

/**
 * Profile endpoints (users/goals/facts). Every route is UserBearer-guarded and derives
 * user_id exclusively from the authenticated principal - never from @Body()/@Query().
 */
@Controller('v1')
@UseGuards(BearerAuthGuard)
export class ProfileController {
  public constructor(
    @Inject(ProfileService)
    private readonly profile: ProfileService,
  ) {}

  @Get('users/me')
  public getCurrentUser(@CurrentUser() principal: AuthenticatedPrincipal) {
    // This repo has no persisted `users` aggregate yet (no migration exists for it, and
    // adding one is outside this ticket's write scope - see the delivery receipt). Until a
    // real User store exists, this returns a contract-shaped stub derived only from the
    // authenticated principal; email/display_name/locale/time_zone/timestamps are placeholders.
    const now = new Date().toISOString();
    return {
      id: principal.userId,
      email: `${principal.userId}@users.invalid`,
      display_name: principal.userId,
      locale: 'en-US',
      time_zone: 'Etc/UTC',
      status: 'active' as const,
      version: 1,
      created_at: now,
      updated_at: now,
    };
  }

  @Get('goals')
  public async listGoals(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('cursor') cursor: string | undefined,
    @Query('page_size') pageSizeParam: string | undefined,
  ): Promise<CursorPage<Goal>> {
    const pageSize = this.parsePageSize(pageSizeParam);
    const goals = await this.profile.listGoals(principal.userId);
    return this.paginate(goals, cursor, pageSize);
  }

  @Post('goals')
  @HttpCode(201)
  public async createGoal(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-correlation-id') correlationId: unknown,
  ): Promise<Goal> {
    const context = this.mutationContext(principal.userId, idempotencyKey, correlationId);
    try {
      return await this.profile.createGoal(principal.userId, body as CreateGoalInput, context);
    } catch (error) {
      throw this.toException(error, context.correlation_id);
    }
  }

  @Get('facts')
  public async listFacts(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('cursor') cursor: string | undefined,
    @Query('page_size') pageSizeParam: string | undefined,
    @Query('status') status: string | undefined,
  ): Promise<CursorPage<Fact>> {
    const pageSize = this.parsePageSize(pageSizeParam);
    if (status !== undefined && !FACT_STATUSES.has(status)) {
      throw httpError(400, 'VALIDATION_FAILED', 'status is invalid.');
    }
    const facts = await this.profile.listFacts(principal.userId, {
      status: status as FactStatus | undefined,
    });
    return this.paginate(facts, cursor, pageSize);
  }

  @Post('facts')
  @HttpCode(201)
  public async createFact(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-correlation-id') correlationId: unknown,
  ): Promise<Fact> {
    const context = this.mutationContext(principal.userId, idempotencyKey, correlationId);
    try {
      return await this.profile.createFact(principal.userId, body as CreateFactInput, context);
    } catch (error) {
      throw this.toException(error, context.correlation_id);
    }
  }

  private mutationContext(
    userId: string,
    idempotencyKey: unknown,
    correlationId: unknown,
  ): MutationContext {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw httpError(
        400,
        'VALIDATION_FAILED',
        'Idempotency-Key header is required and must be 16-128 visible ASCII characters.',
      );
    }
    if (
      correlationId !== undefined &&
      (typeof correlationId !== 'string' || !UUID_PATTERN.test(correlationId))
    ) {
      throw httpError(400, 'VALIDATION_FAILED', 'X-Correlation-Id must be a UUID.');
    }
    return {
      actor_id: userId,
      request_id: randomUUID(),
      correlation_id: typeof correlationId === 'string' ? correlationId : randomUUID(),
      idempotency_key: idempotencyKey,
    };
  }

  private parsePageSize(value: string | undefined): number {
    if (value === undefined) return 25;
    const pageSize = Number(value);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw httpError(400, 'VALIDATION_FAILED', 'page_size must be an integer from 1 to 100.');
    }
    return pageSize;
  }

  private paginate<T extends { id: string }>(
    items: T[],
    cursor: string | undefined,
    pageSize: number,
  ): CursorPage<T> {
    let start = 0;
    if (cursor !== undefined) {
      const index = items.findIndex((item) => item.id === cursor);
      if (index < 0) {
        throw httpError(400, 'VALIDATION_FAILED', 'cursor is invalid for this result set.');
      }
      start = index + 1;
    }
    const page = items.slice(start, start + pageSize);
    return {
      items: page,
      page: {
        page_size: pageSize,
        next_cursor: start + page.length < items.length ? (page.at(-1)?.id ?? null) : null,
        total_estimate: items.length,
      },
    };
  }

  private toException(error: unknown, correlationId: string): unknown {
    if (error instanceof ProfileError) {
      return toHttpException(error, correlationId);
    }
    return error;
  }
}
