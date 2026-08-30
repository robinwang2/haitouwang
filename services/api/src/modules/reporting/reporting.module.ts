import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { AuthService } from '../../auth.service';
import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { REPORTING_STORE } from './reporting-store.interface';
import type { ReportingStore } from './reporting-store.interface';
import { PostgresReportingStore } from './reporting.postgres-store';
import { ReportingController } from './reporting.controller';
import { REPORTING_SERVICE_OPTIONS, ReportingService } from './reporting.service';
import type { ReportingServiceOptions } from './reporting.types';

function createReportingStore(): ReportingStore {
  return createLazyPostgresStore<ReportingStore>(
    'ReportingModule',
    {
      withTransaction: true,
      getPreferences: true,
      savePreferences: true,
      getNotification: true,
      saveNotification: true,
      listNotifications: true,
      findNotificationIdByDedupeKey: true,
      saveNotificationDedupe: true,
      getSourceRecord: true,
      saveSourceRecord: true,
      listSourceRecords: true,
      getReport: true,
      getReportById: true,
      saveReport: true,
    },
    (pool) => new PostgresReportingStore(pool),
  );
}

@Module({
  controllers: [ReportingController],
  providers: [
    { provide: REPORTING_SERVICE_OPTIONS, useValue: {} },
    ReportingService,
    { provide: REPORTING_STORE, useFactory: createReportingStore },
    AuthService,
  ],
  exports: [ReportingService, REPORTING_STORE],
})
export class ReportingModule {
  public static register(options: ReportingServiceOptions): DynamicModule {
    return {
      module: ReportingModule,
      providers: [{ provide: REPORTING_SERVICE_OPTIONS, useValue: options }],
    };
  }
}
