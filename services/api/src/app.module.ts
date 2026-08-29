import { Module } from '@nestjs/common';

import { AuthService } from './auth.service';
import { ApplicationsModule } from './modules/applications';
import { JobsModule } from './modules/jobs';
import { MaterialsModule } from './modules/materials';
import { ProfileModule } from './modules/profile';
import { ReportingModule } from './modules/reporting';
import { UserModule } from './modules/user';
import { WorkflowController } from './workflow.controller';

@Module({
  imports: [
    MaterialsModule,
    JobsModule,
    ProfileModule,
    UserModule,
    ApplicationsModule,
    ReportingModule,
  ],
  controllers: [WorkflowController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AppModule {}
