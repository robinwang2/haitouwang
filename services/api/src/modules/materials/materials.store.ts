import { Injectable } from '@nestjs/common';

import type { MaterialsStore } from './materials-store.interface';
import type { Material, MaterialAuditEvent } from './materials.types';

export type MaterialsWriteKind = 'material' | 'audit';
export type MaterialsWriteObserver = (
  kind: MaterialsWriteKind,
  value: Material | MaterialAuditEvent,
) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function versionKey(materialId: string, version: number): string {
  return `${materialId}:${version}`;
}

@Injectable()
export class InMemoryMaterialsStore implements MaterialsStore {
  private readonly versions = new Map<string, Material>();
  private auditEvents: MaterialAuditEvent[] = [];

  public constructor(private readonly beforeWrite: MaterialsWriteObserver = () => undefined) {}

  async withTransaction<T>(operation: (store: MaterialsStore) => Promise<T>): Promise<T> {
    const versions = new Map([...this.versions].map(([key, value]) => [key, clone(value)]));
    const auditEvents = this.auditEvents.map(clone);
    try {
      return await operation(this);
    } catch (error) {
      this.versions.clear();
      for (const [key, value] of versions) this.versions.set(key, value);
      this.auditEvents = auditEvents;
      throw error;
    }
  }

  async hasMaterial(userId: string, materialId: string): Promise<boolean> {
    for (const material of this.versions.values()) {
      if (material.id === materialId && material.user_id === userId) return true;
    }
    return false;
  }

  async saveMaterial(userId: string, material: Material): Promise<void> {
    if (material.user_id !== userId) {
      throw new Error('Materials store tenant mismatch.');
    }
    const key = versionKey(material.id, material.version);
    if (this.versions.has(key)) {
      throw new Error(`Material version already exists: ${key}`);
    }
    this.beforeWrite('material', material);
    this.versions.set(key, clone(material));
  }

  async getCurrentMaterial(userId: string, materialId: string): Promise<Material | undefined> {
    const versions = this.materialVersions(userId, materialId);
    if (versions.length === 0) return undefined;
    return clone(versions[versions.length - 1]);
  }

  async getMaterialVersion(
    userId: string,
    materialId: string,
    version: number,
  ): Promise<Material | undefined> {
    const material = this.versions.get(versionKey(materialId, version));
    if (!material || material.user_id !== userId) return undefined;
    return clone(material);
  }

  async listCurrentMaterials(userId: string): Promise<Material[]> {
    const currentByMaterial = new Map<string, Material>();
    for (const material of this.versions.values()) {
      if (material.user_id !== userId) continue;
      const current = currentByMaterial.get(material.id);
      if (!current || material.version > current.version) {
        currentByMaterial.set(material.id, material);
      }
    }
    return [...currentByMaterial.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(clone);
  }

  async listMaterialVersions(userId: string, materialId: string): Promise<Material[]> {
    return this.materialVersions(userId, materialId).map(clone);
  }

  async appendAuditEvent(userId: string, event: MaterialAuditEvent): Promise<void> {
    if (event.user_id !== userId) {
      throw new Error('Materials store tenant mismatch.');
    }
    this.beforeWrite('audit', event);
    this.auditEvents.push(clone(event));
  }

  async appendRejectedAuditEvent(
    actorUserId: string | undefined,
    materialId: string,
    event: Omit<MaterialAuditEvent, 'user_id' | 'actor' | 'material_id' | 'material_version'>,
  ): Promise<void> {
    const material = this.currentMaterialById(materialId);
    if (!material) return;
    await this.appendAuditEvent(material.user_id, {
      ...clone(event),
      user_id: material.user_id,
      actor: actorUserId ? { type: 'user', id: actorUserId } : { type: 'system', id: 'anonymous' },
      material_id: materialId,
      material_version: material.version,
    });
  }

  async listAuditEvents(userId: string): Promise<MaterialAuditEvent[]> {
    return this.auditEvents.filter((event) => event.user_id === userId).map(clone);
  }

  private materialVersions(userId: string, materialId: string): Material[] {
    return [...this.versions.values()]
      .filter((material) => material.id === materialId && material.user_id === userId)
      .sort((left, right) => left.version - right.version);
  }

  private currentMaterialById(materialId: string): Material | undefined {
    return [...this.versions.values()]
      .filter((material) => material.id === materialId)
      .sort((left, right) => right.version - left.version)[0];
  }
}
