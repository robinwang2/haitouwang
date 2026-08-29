import type { Material, MaterialAuditEvent } from './materials.types';

export const MATERIALS_STORE = Symbol('MATERIALS_STORE');

/**
 * Persistence boundary for the Material aggregate (versions + audit trail). Every
 * operation is tenant-scoped by user_id. This models the durable replacement for
 * MaterialsRepository's `material_versions` and `material_audit_events` tables.
 *
 * materials.service.ts is not wired to this interface: WorkflowController calls its
 * methods synchronously today (see materials.repository.ts / materials.service.ts),
 * and this ticket only introduces the storage abstraction, not the async request-path
 * migration that would be required to switch the live service over to it.
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
  listAuditEvents(userId: string): Promise<MaterialAuditEvent[]>;
}
