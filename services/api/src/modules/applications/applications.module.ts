import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { APPLICATION_SERVICE_OPTIONS, ApplicationsService } from './applications.service';
import type { ApplicationServiceOptions } from './applications.types';

@Module({
  providers: [{ provide: APPLICATION_SERVICE_OPTIONS, useValue: {} }, ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {
  public static register(options: ApplicationServiceOptions): DynamicModule {
    return {
      module: ApplicationsModule,
      providers: [{ provide: APPLICATION_SERVICE_OPTIONS, useValue: options }],
    };
  }
}
