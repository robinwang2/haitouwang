import { Module } from '@nestjs/common';

import { AuthService } from './auth.service';
import { JobsModule } from './modules/jobs';
import { MaterialsModule } from './modules/materials';
import { ProfileModule } from './modules/profile';
import { WorkflowController } from './workflow.controller';

@Module({
  imports: [MaterialsModule, JobsModule, ProfileModule],
  controllers: [WorkflowController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AppModule {}
