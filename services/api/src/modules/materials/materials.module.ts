import { Module } from '@nestjs/common';

import { MaterialsService } from './materials.service';
import { MaterialsRepository } from './materials.repository';

@Module({
  providers: [MaterialsRepository, MaterialsService],
  exports: [MaterialsRepository, MaterialsService],
})
export class MaterialsModule {}
