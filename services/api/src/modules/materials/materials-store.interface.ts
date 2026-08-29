import type { Material, MaterialAuditEvent } from './materials.types';

export const MATERIALS_STORE = Symbol('MATERIALS_STORE');

/**
 * Persistence boundary for the Material aggregate (versions + audit trail).
 * Normal aggregate operations are tenant-scoped by user_id. Rejected access audits
 * resolve ownership internally so callers cannot read another tenant's material.
 */
export interface MaterialsStore {
  withTransaction<T>(operation: (store: MaterialsStore) => Promise<T>): Promise<T>;

  hasMaterial(userId: string, materialId: string): Promise<boolean>;
  saveMaterial(userId: string, material: Material): Promise<void>;
  getCurrentMaterial(userId: string, materialId: string): Promise<Material | undefined>;
  getMaterialVersion(
    userId: string,
    materialId: string,
    version: number,
  ): Promise<Material | undefined>;
  listCurrentMaterials(userId: string): Promise<Material[]>;
  listMaterialVersions(userId: string, materialId: string): Promise<Material[]>;

  appendAuditEvent(userId: string, event: MaterialAuditEvent): Promise<void>;
  appendRejectedAuditEvent(
    actorUserId: string | undefined,
    materialId: string,
    event: Omit<MaterialAuditEvent, 'user_id' | 'actor' | 'material_id' | 'material_version'>,
  ): Promise<void>;
  listAuditEvents(userId: string): Promise<MaterialAuditEvent[]>;
}
