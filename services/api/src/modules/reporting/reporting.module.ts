import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { REPORTING_SERVICE_OPTIONS, ReportingService } from './reporting.service';
import type { ReportingServiceOptions } from './reporting.types';

@Module({
  providers: [{ provide: REPORTING_SERVICE_OPTIONS, useValue: {} }, ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {
  public static register(options: ReportingServiceOptions): DynamicModule {
    return {
      module: ReportingModule,
      providers: [{ provide: REPORTING_SERVICE_OPTIONS, useValue: options }],
    };
  }
}
