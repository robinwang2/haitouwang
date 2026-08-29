import { Module } from '@nestjs/common';

import { AuthService } from './auth.service';
import { JobsModule } from './modules/jobs';
import { MaterialsModule } from './modules/materials';
import { ProfileModule } from './modules/profile';
import { UserModule } from './modules/user';
import { WorkflowController } from './workflow.controller';

@Module({
  imports: [MaterialsModule, JobsModule, ProfileModule, UserModule],
  controllers: [WorkflowController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AppModule {}
