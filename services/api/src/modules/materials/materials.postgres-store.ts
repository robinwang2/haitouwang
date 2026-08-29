import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { MaterialsStore } from './materials-store.interface';
import type {
  GeneratedMaterialKind,
  Material,
  MaterialAuditEvent,
  MaterialChecks,
  MaterialDocument,
  MaterialFactCitation,
  MaterialGenerationCost,
  MaterialStatus,
} from './materials.types';

type Executor = Pool | PoolClient;

interface MaterialRow extends QueryResultRow {
  material_id: string;
  user_id: string;
  job_id: string | null;
  kind: GeneratedMaterialKind;
  status: MaterialStatus;
  version: number;
  file_ids: string[];
  supersedes_id: string | null;
  document: MaterialDocument;
  checks: MaterialChecks;
  generation: MaterialGenerationCost;
  fact_citations: MaterialFactCitation[];
  created_at: Date;
  updated_at: Date;
}

interface AuditRow extends QueryResultRow {
  event_id: string;
  user_id: string;
  material_id: string;
  material_version: number;
  action: MaterialAuditEvent['action'];
  occurred_at: Date;
  actor: MaterialAuditEvent['actor'];
  changed_fields: string[];
  outcome: MaterialAuditEvent['outcome'] | null;
  reason_code: string | null;
}

function mapMaterial(row: MaterialRow): Material {
  return {
    id: row.material_id,
    user_id: row.user_id,
    ...(row.job_id ? { job_id: row.job_id } : {}),
    kind: row.kind,
    status: row.status,
    version: row.version,
    file_ids: row.file_ids,
    fact_citations: row.fact_citations,
    ...(row.supersedes_id ? { supersedes_id: row.supersedes_id } : {}),
    document: row.document,
    checks: row.checks,
    generation: row.generation,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapAudit(row: AuditRow): MaterialAuditEvent {
  return {
    event_id: row.event_id,
    user_id: row.user_id,
    actor: row.actor,
    material_id: row.material_id,
    material_version: row.material_version,
    action: row.action,
    occurred_at: row.occurred_at.toISOString(),
    changed_fields: row.changed_fields,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.reason_code ? { reason_code: row.reason_code } : {}),
  };
}

/**
 * Postgres-backed implementation of MaterialsStore. Every statement scopes its WHERE
 * clause by user_id; row-level tenant isolation is enforced in SQL. Fact citations are
 * additionally normalized into materials_fact_citations, whose foreign keys guarantee both
 * that a citation can never outlive (or precede) the material version it was written
 * against (materials_versions(material_id, version)) and that it only ever points at a
 * fact version that actually exists (profile_fact_versions(resource_id, version)).
 * saveMaterial runs its multi-statement write in its own transaction when called directly
 * on the pool, so a rejected citation cannot leave a dangling materials_versions row.
 */
export class PostgresMaterialsStore implements MaterialsStore {
  constructor(
    readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  async withTransaction<T>(operation: (store: MaterialsStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresMaterialsStore(this.pool, client);
      const result = await operation(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async hasMaterial(userId: string, materialId: string): Promise<boolean> {
    const { rows } = await this.executor.query(
      'SELECT 1 FROM materials_versions WHERE material_id = $1 AND user_id = $2 LIMIT 1',
      [materialId, userId],
    );
    return rows.length > 0;
  }

  async saveMaterial(userId: string, material: Material): Promise<void> {
    if (material.user_id !== userId) {
      throw new Error('Materials store tenant mismatch.');
    }
    if (this.executor === this.pool) {
      await this.withTransaction((scoped) => scoped.saveMaterial(userId, material));
      return;
    }
    await this.executor.query(
      `INSERT INTO materials_versions (
         material_id, user_id, job_id, kind, status, version, file_ids, supersedes_id,
         document, checks, generation, fact_citations, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        material.id,
        userId,
        material.job_id ?? null,
        material.kind,
        material.status,
        material.version,
        material.file_ids,
        material.supersedes_id ?? null,
        JSON.stringify(material.document),
        JSON.stringify(material.checks),
        JSON.stringify(material.generation),
        JSON.stringify(material.fact_citations),
        material.created_at,
        material.updated_at,
      ],
    );
    await this.executor.query(
      'DELETE FROM materials_fact_citations WHERE material_id = $1 AND material_version = $2 AND user_id = $3',
      [material.id, material.version, userId],
    );
    for (const citation of material.fact_citations) {
      await this.executor.query(
        `INSERT INTO materials_fact_citations (
           id, material_id, material_version, fact_id, fact_version, claim_path, user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          material.id,
          material.version,
          citation.fact_id,
          citation.fact_version,
          citation.claim_path,
          userId,
        ],
      );
    }
  }

  async getCurrentMaterial(userId: string, materialId: string): Promise<Material | undefined> {
    const { rows } = await this.executor.query<MaterialRow>(
      `SELECT * FROM materials_versions
       WHERE material_id = $1 AND user_id = $2
       ORDER BY version DESC LIMIT 1`,
      [materialId, userId],
    );
    return rows[0] ? mapMaterial(rows[0]) : undefined;
  }

  async getMaterialVersion(
    userId: string,
    materialId: string,
    version: number,
  ): Promise<Material | undefined> {
    const { rows } = await this.executor.query<MaterialRow>(
      'SELECT * FROM materials_versions WHERE material_id = $1 AND version = $2 AND user_id = $3',
      [materialId, version, userId],
    );
    return rows[0] ? mapMaterial(rows[0]) : undefined;
  }

  async listCurrentMaterials(userId: string): Promise<Material[]> {
    const { rows } = await this.executor.query<MaterialRow>(
      `SELECT current.* FROM materials_versions AS current
       WHERE current.user_id = $1
         AND current.version = (
           SELECT MAX(candidate.version) FROM materials_versions AS candidate
           WHERE candidate.material_id = current.material_id AND candidate.user_id = $1
         )
       ORDER BY current.material_id`,
      [userId],
    );
    return rows.map(mapMaterial);
  }

  async listMaterialVersions(userId: string, materialId: string): Promise<Material[]> {
    const { rows } = await this.executor.query<MaterialRow>(
      `SELECT * FROM materials_versions
       WHERE material_id = $1 AND user_id = $2
       ORDER BY version ASC`,
      [materialId, userId],
    );
    return rows.map(mapMaterial);
  }

  async appendAuditEvent(userId: string, event: MaterialAuditEvent): Promise<void> {
    if (event.user_id !== userId) {
      throw new Error('Materials store tenant mismatch.');
    }
    await this.executor.query(
      `INSERT INTO materials_audit_events (
         event_id, user_id, material_id, material_version, action, occurred_at, actor,
         changed_fields, outcome, reason_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        event.event_id,
        userId,
        event.material_id,
        event.material_version,
        event.action,
        event.occurred_at,
        JSON.stringify(event.actor),
        event.changed_fields,
        event.outcome ?? null,
        event.reason_code ?? null,
      ],
    );
  }

  async listAuditEvents(userId: string): Promise<MaterialAuditEvent[]> {
    const { rows } = await this.executor.query<AuditRow>(
      'SELECT * FROM materials_audit_events WHERE user_id = $1 ORDER BY occurred_at, event_id',
      [userId],
    );
    return rows.map(mapAudit);
  }
}
