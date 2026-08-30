import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMaterialsStore } from '../../src/modules/materials';
import type {
  Material,
  MaterialAuditEvent,
  MaterialFactCitation,
} from '../../src/modules/materials';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[materials.postgres-store] DATABASE_URL is not set - skipping PostgresMaterialsStore ' +
      'integration tests. This sandbox has no Docker/Postgres available (see ' +
      'docs/qa/mvp-report.md); set DATABASE_URL to a disposable Postgres instance to exercise ' +
      'the real SQL implementation.',
  );
}

const MATERIALS_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/materials',
);

// materials_fact_citations has a foreign key into profile_fact_versions, so the profile
// module's tables must exist in the same schema before the materials migrations run.
const PROFILE_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/profile',
);

async function migrationSql(dir: string, suffix: '.up.sql' | '.down.sql'): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(suffix)).sort();
  return Promise.all(files.map((file) => readFile(path.join(dir, file), 'utf8')));
}

async function applySchema(pool: Pool): Promise<void> {
  for (const sql of await migrationSql(PROFILE_MIGRATIONS_DIR, '.up.sql')) {
    await pool.query(sql);
  }
  for (const sql of await migrationSql(MATERIALS_MIGRATIONS_DIR, '.up.sql')) {
    await pool.query(sql);
  }
}

async function resetSchema(pool: Pool): Promise<void> {
  for (const sql of (await migrationSql(MATERIALS_MIGRATIONS_DIR, '.down.sql')).reverse()) {
    await pool.query(sql);
  }
  for (const sql of (await migrationSql(PROFILE_MIGRATIONS_DIR, '.down.sql')).reverse()) {
    await pool.query(sql);
  }
}

/** Inserts a real profile_facts + profile_fact_versions row so a citation can legally point at it. */
async function seedFact(
  pool: Pool,
  userId: string,
  overrides: { factId?: string; version?: number } = {},
): Promise<MaterialFactCitation> {
  const fact_id = overrides.factId ?? randomUUID();
  const fact_version = overrides.version ?? 1;
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO profile_facts (
       id, user_id, kind, value, scope, status, source, version, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      fact_id,
      userId,
      'skill',
      JSON.stringify({ skill: 'TypeScript' }),
      JSON.stringify({ use: 'resume' }),
      'confirmed',
      JSON.stringify({ type: 'user', reference: 'test-fixture' }),
      fact_version,
      now,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO profile_fact_versions (resource_id, user_id, version, recorded_at, snapshot)
     VALUES ($1,$2,$3,$4,$5)`,
    [fact_id, userId, fact_version, now, JSON.stringify({})],
  );
  return { fact_id, fact_version, claim_path: 'claims.0' };
}

function materialFixture(
  userId: string,
  citation: MaterialFactCitation,
  overrides: Partial<Material> = {},
): Material {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: userId,
    job_id: randomUUID(),
    kind: 'resume',
    status: 'review_required',
    version: 1,
    file_ids: [],
    fact_citations: [citation],
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
    await applySchema(pool);
    store = new PostgresMaterialsStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  it('round-trips a material version and enforces user_id scoping in SQL', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const citation = await seedFact(pool, userId);
    const material = materialFixture(userId, citation);

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
    const citation = await seedFact(pool, userId);
    const first = materialFixture(userId, citation);
    const second = materialFixture(userId, citation, {
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
    const citation = await seedFact(pool, userId);
    const material = materialFixture(userId, citation);
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
    const citation = await seedFact(pool, userId);
    const material = materialFixture(userId, citation);

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
    const citation = await seedFact(pool, userId);

    await expect(
      pool.query(
        `INSERT INTO materials_fact_citations (
           id, material_id, material_version, fact_id, fact_version, claim_path, user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          nonExistentMaterialId,
          1,
          citation.fact_id,
          citation.fact_version,
          'claims.0',
          userId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const material = materialFixture(userId, citation);
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

  it('rejects saveMaterial when a fact citation points at a fact_id that does not exist', async () => {
    const userId = randomUUID();
    const unknownCitation: MaterialFactCitation = {
      fact_id: randomUUID(),
      fact_version: 1,
      claim_path: 'claims.0',
    };
    const material = materialFixture(userId, unknownCitation);

    await expect(store.saveMaterial(userId, material)).rejects.toMatchObject({ code: '23503' });

    // The rejected write must not leave a dangling materials_versions row behind: saveMaterial
    // runs its multi-statement insert in a transaction, so the fact FK violation rolls back
    // the material row too, not just the citation row.
    expect(await store.getCurrentMaterial(userId, material.id)).toBeUndefined();
    const { rows } = await pool.query(
      'SELECT 1 FROM materials_fact_citations WHERE material_id = $1 AND user_id = $2',
      [material.id, userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects saveMaterial when a fact citation points at an existing fact but the wrong version', async () => {
    const userId = randomUUID();
    const citation = await seedFact(pool, userId);
    const wrongVersionCitation: MaterialFactCitation = {
      fact_id: citation.fact_id,
      fact_version: citation.fact_version + 1,
      claim_path: 'claims.0',
    };
    const material = materialFixture(userId, wrongVersionCitation);

    await expect(store.saveMaterial(userId, material)).rejects.toMatchObject({ code: '23503' });
    expect(await store.getCurrentMaterial(userId, material.id)).toBeUndefined();
  });
});
