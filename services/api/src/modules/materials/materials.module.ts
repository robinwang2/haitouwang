import { Module } from '@nestjs/common';

import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { MATERIALS_STORE } from './materials-store.interface';
import type { MaterialsStore } from './materials-store.interface';
import { MaterialsService } from './materials.service';
import { MaterialsRepository } from './materials.repository';
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
      listAuditEvents: true,
    },
    (pool) => new PostgresMaterialsStore(pool),
  );
}

@Module({
  providers: [
    MaterialsRepository,
    MaterialsService,
    { provide: MATERIALS_STORE, useFactory: createMaterialsStore },
  ],
  exports: [MaterialsRepository, MaterialsService, MATERIALS_STORE],
})
export class MaterialsModule {}
