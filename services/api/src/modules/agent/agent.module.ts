import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { AgentController } from './agent.controller';
import { AGENT_SERVICE_OPTIONS, AgentService } from './agent.service';

import type { AgentServiceOptions } from './agent.types';

@Module({
  controllers: [AgentController],
  providers: [
    {
      provide: AGENT_SERVICE_OPTIONS,
      useValue: {},
    },
    AgentService,
  ],
  exports: [AgentService],
})
export class AgentModule {
  static register(options: AgentServiceOptions): DynamicModule {
    return {
      module: AgentModule,
      providers: [
        {
          provide: AGENT_SERVICE_OPTIONS,
          useValue: options,
        },
      ],
    };
  }
}
