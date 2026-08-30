import { Module } from '@nestjs/common';

import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { ReviewModule } from '../review';
import { MATERIALS_STORE } from './materials-store.interface';
import type { MaterialsStore } from './materials-store.interface';
import { MaterialsService } from './materials.service';
import { PostgresMaterialsStore } from './materials.postgres-store';

function createMaterialsStore(): MaterialsStore {
  return createLazyPostgresStore<MaterialsStore>(
    'MaterialsModule',
    {
      withTransaction: true,
      hasMaterial: true,
      saveMaterial: true,
      getCurrentMaterial: true,
      getMaterialVersion: true,
      listCurrentMaterials: true,
      listMaterialVersions: true,
      appendAuditEvent: true,
      appendRejectedAuditEvent: true,
      listAuditEvents: true,
    },
    (pool) => new PostgresMaterialsStore(pool),
  );
}

@Module({
  imports: [ReviewModule],
  providers: [MaterialsService, { provide: MATERIALS_STORE, useFactory: createMaterialsStore }],
  exports: [MaterialsService, MATERIALS_STORE, ReviewModule],
})
export class MaterialsModule {}
