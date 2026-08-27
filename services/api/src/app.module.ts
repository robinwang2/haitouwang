import { Module } from '@nestjs/common';

import { AuthService } from './auth.service';
import { JobsModule } from './modules/jobs';
import { MaterialsModule } from './modules/materials';
import { WorkflowController } from './workflow.controller';

@Module({
  imports: [MaterialsModule, JobsModule],
  controllers: [WorkflowController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AppModule {}
