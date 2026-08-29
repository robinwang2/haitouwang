import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMaterialsStore } from '../../src/modules/materials';
import type { Material, MaterialAuditEvent } from '../../src/modules/materials';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[materials.postgres-store] DATABASE_URL is not set - skipping PostgresMaterialsStore ' +
      'integration tests. This sandbox has no Docker/Postgres available (see ' +
      'docs/qa/mvp-report.md); set DATABASE_URL to a disposable Postgres instance to exercise ' +
      'the real SQL implementation.',
  );
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/materials',
);

async function migrationSql(suffix: '.up.sql' | '.down.sql'): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(suffix)).sort();
  return Promise.all(files.map((file) => readFile(path.join(MIGRATIONS_DIR, file), 'utf8')));
}

async function resetSchema(pool: Pool): Promise<void> {
  const downSqls = (await migrationSql('.down.sql')).reverse();
  for (const sql of downSqls) {
    await pool.query(sql);
  }
}

function materialFixture(userId: string, overrides: Partial<Material> = {}): Material {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: userId,
    job_id: randomUUID(),
    kind: 'resume',
    status: 'review_required',
    version: 1,
    file_ids: [],
    fact_citations: [{ fact_id: randomUUID(), fact_version: 1, claim_path: 'claims.0' }],
    document: { kind: 'resume', sections: [], claims: [], plain_text: 'Sample resume text.' },
    checks: {
      word_count: 3,
      character_count: 20,
      ats_compatible: true,
      has_placeholders: false,
      publishable: true,
      issues: [],
    },
    generation: {
      strategy: 'deterministic_fact_template',
      external_model_calls: 0,
      input_characters: 50,
      output_characters: 20,
      estimated_input_tokens: 12,
      estimated_output_tokens: 5,
    },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function auditEventFixture(material: Material): MaterialAuditEvent {
  return {
    event_id: randomUUID(),
    user_id: material.user_id,
    actor: { type: 'user', id: material.user_id },
    material_id: material.id,
    material_version: material.version,
    action: 'material.draft_created',
    occurred_at: new Date().toISOString(),
    changed_fields: ['status'],
  };
}

describe.skipIf(!DATABASE_URL)('PostgresMaterialsStore integration', () => {
  let pool: Pool;
  let store: PostgresMaterialsStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(pool);
    const upSqls = await migrationSql('.up.sql');
    for (const sql of upSqls) {
      await pool.query(sql);
    }
    store = new PostgresMaterialsStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  it('round-trips a material version and enforces user_id scoping in SQL', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const material = materialFixture(userId);

    await store.saveMaterial(userId, material);

    expect(await store.getCurrentMaterial(userId, material.id)).toEqual(material);
    expect(await store.getCurrentMaterial(otherUserId, material.id)).toBeUndefined();
    expect(await store.hasMaterial(userId, material.id)).toBe(true);
    expect(await store.hasMaterial(otherUserId, material.id)).toBe(false);
    expect((await store.listCurrentMaterials(userId)).map((row) => row.id)).toEqual([material.id]);
    expect(await store.listCurrentMaterials(otherUserId)).toEqual([]);
  });

  it('resolves the highest version as current and lists all versions in order', async () => {
    const userId = randomUUID();
    const first = materialFixture(userId);
    const second = materialFixture(userId, {
      id: first.id,
      job_id: first.job_id,
      version: 2,
      status: 'approved',
    });

    await store.saveMaterial(userId, first);
    await store.saveMaterial(userId, second);

    expect(await store.getCurrentMaterial(userId, first.id)).toEqual(second);
    expect(await store.getMaterialVersion(userId, first.id, 1)).toEqual(first);
    expect((await store.listMaterialVersions(userId, first.id)).map((row) => row.version)).toEqual([
      1, 2,
    ]);
  });

  it('persists and lists audit events scoped by tenant', async () => {
    const userId = randomUUID();
    const material = materialFixture(userId);
    await store.saveMaterial(userId, material);
    const event = auditEventFixture(material);
    await store.appendAuditEvent(userId, event);

    expect((await store.listAuditEvents(userId)).map((row) => row.event_id)).toEqual([
      event.event_id,
    ]);
    expect(await store.listAuditEvents(randomUUID())).toEqual([]);
  });

  it('rolls back all writes when the transaction callback throws', async () => {
    const userId = randomUUID();
    const material = materialFixture(userId);

    await expect(
      store.withTransaction(async (scoped) => {
        await scoped.saveMaterial(userId, material);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.getCurrentMaterial(userId, material.id)).toBeUndefined();
  });

  it('enforces the materials_fact_citations foreign key against materials_versions', async () => {
    const userId = randomUUID();
    const nonExistentMaterialId = randomUUID();

    await expect(
      pool.query(
        `INSERT INTO materials_fact_citations (
           id, material_id, material_version, fact_id, fact_version, claim_path, user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), nonExistentMaterialId, 1, randomUUID(), 1, 'claims.0', userId],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const material = materialFixture(userId);
    await store.saveMaterial(userId, material);
    const { rows } = await pool.query(
      'SELECT fact_id FROM materials_fact_citations WHERE material_id = $1 AND user_id = $2',
      [material.id, userId],
    );
    expect(rows).toHaveLength(material.fact_citations.length);

    await expect(
      pool.query('DELETE FROM materials_versions WHERE material_id = $1 AND user_id = $2', [
        material.id,
        userId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    const { rows: afterCascade } = await pool.query(
      'SELECT fact_id FROM materials_fact_citations WHERE material_id = $1 AND user_id = $2',
      [material.id, userId],
    );
    expect(afterCascade).toHaveLength(0);
  });
});
