import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../../auth.service';
import { BearerAuthGuard } from '../../common/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import { httpError } from '../../common/http-error';
import { ReportingService } from './reporting.service';
import type { Notification } from './reporting.types';

interface PageMeta {
  page_size: number;
  next_cursor: string | null;
  total_estimate: number;
}

interface NotificationPage {
  items: Notification[];
  page: PageMeta;
}

@Controller('v1')
@UseGuards(BearerAuthGuard)
export class ReportingController {
  public constructor(
    @Inject(ReportingService)
    private readonly reporting: ReportingService,
  ) {}

  @Get('notifications')
  public async listNotifications(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('cursor') cursor: string | undefined,
    @Query('page_size') pageSizeParam: string | undefined,
  ): Promise<NotificationPage> {
    const pageSize = this.parsePageSize(pageSizeParam);
    const notifications = await this.reporting.listNotifications(principal.userId);
    return this.paginate(notifications, cursor, pageSize);
  }

  private parsePageSize(value: string | undefined): number {
    if (value === undefined) return 25;
    const pageSize = Number(value);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw httpError(400, 'VALIDATION_FAILED', 'page_size must be an integer from 1 to 100.');
    }
    return pageSize;
  }

  private paginate(
    items: Notification[],
    cursor: string | undefined,
    pageSize: number,
  ): NotificationPage {
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
