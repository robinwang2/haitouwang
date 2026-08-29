import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { APPLICATIONS_STORE } from './applications-store.interface';
import type { ApplicationsStore } from './applications-store.interface';
import { PostgresApplicationsStore } from './applications.postgres-store';
import { APPLICATION_SERVICE_OPTIONS, ApplicationsService } from './applications.service';
import type { ApplicationServiceOptions } from './applications.types';

function createApplicationsStore(): ApplicationsStore {
  return createLazyPostgresStore<ApplicationsStore>(
    'ApplicationsModule',
    {
      withTransaction: true,
      getApplication: true,
      saveApplication: true,
      listApplications: true,
      findApplicationIdBySubmissionKey: true,
      saveManualTask: true,
      listManualTasks: true,
      getIdempotencyRecord: true,
      saveIdempotencyRecord: true,
      getReceipt: true,
      saveReceipt: true,
      appendAuditEvent: true,
      listAuditEvents: true,
    },
    (pool) => new PostgresApplicationsStore(pool),
  );
}

@Module({
  providers: [
    { provide: APPLICATION_SERVICE_OPTIONS, useValue: {} },
    ApplicationsService,
    { provide: APPLICATIONS_STORE, useFactory: createApplicationsStore },
  ],
  exports: [ApplicationsService, APPLICATIONS_STORE],
})
export class ApplicationsModule {
  public static register(options: ApplicationServiceOptions): DynamicModule {
    return {
      module: ApplicationsModule,
      providers: [{ provide: APPLICATION_SERVICE_OPTIONS, useValue: options }],
    };
  }
}
