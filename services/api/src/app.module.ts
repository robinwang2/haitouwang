import { Module } from '@nestjs/common';

import { AuthService } from './auth.service';
import { MaterialsModule } from './modules/materials';
import { WorkflowController } from './workflow.controller';

@Module({
  imports: [MaterialsModule],
  controllers: [WorkflowController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AppModule {}
