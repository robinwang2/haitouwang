import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../../auth.service';
import { BearerAuthGuard } from '../../common/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import { httpError } from '../../common/http-error';
import { ApplicationsService } from './applications.service';
import type { Application, ApplicationStatus, ManualApplicationTask } from './applications.types';

const APPLICATION_STATUSES = new Set<string>([
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

type TaskResponse = Omit<ManualApplicationTask, 'package'>;

@Controller('v1')
@UseGuards(BearerAuthGuard)
export class ApplicationsController {
  public constructor(
    @Inject(ApplicationsService)
    private readonly applications: ApplicationsService,
  ) {}

  @Get('applications')
  public async listApplications(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('cursor') cursor: string | undefined,
    @Query('page_size') pageSizeParam: string | undefined,
    @Query('status') status: string | undefined,
  ): Promise<CursorPage<Application>> {
    const pageSize = this.parsePageSize(pageSizeParam);
    if (status !== undefined && !APPLICATION_STATUSES.has(status)) {
      throw httpError(400, 'VALIDATION_FAILED', 'status is invalid.');
    }
    const applications = await this.applications.listApplications(principal.userId, {
      statuses: status === undefined ? undefined : [status as ApplicationStatus],
    });
    return this.paginate(applications, cursor, pageSize);
  }

  @Get('tasks')
  public async listTasks(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('cursor') cursor: string | undefined,
    @Query('page_size') pageSizeParam: string | undefined,
  ): Promise<CursorPage<TaskResponse>> {
    const pageSize = this.parsePageSize(pageSizeParam);
    const tasks = await this.applications.listManualTasks(principal.userId);
    const contractTasks = tasks.map(({ package: _internalPackage, ...task }) => task);
    return this.paginate(contractTasks, cursor, pageSize);
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
}
