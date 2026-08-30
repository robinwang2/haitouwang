import { describe, expect, it } from 'vitest';

import {
  InMemoryMaterialsStore,
  type Material,
  type MaterialAuditEvent,
} from '../../src/modules/materials';

import { NOW, OTHER_USER_ID, USER_ID } from './fixtures/material-facts';

function material(overrides: Partial<Material> = {}): Material {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    job_id: '20000000-0000-4000-8000-000000000001',
    kind: 'resume',
    status: 'review_required',
    version: 1,
    file_ids: [],
    fact_citations: [
      { fact_id: '40000000-0000-4000-8000-000000000001', fact_version: 1, claim_path: 'claims.0' },
    ],
    document: {
      kind: 'resume',
      sections: [],
      claims: [],
      plain_text: 'Ada Lovelace, backend engineer.',
    },
    checks: {
      word_count: 4,
      character_count: 32,
      ats_compatible: true,
      has_placeholders: false,
      publishable: true,
      issues: [],
    },
    generation: {
      strategy: 'deterministic_fact_template',
      external_model_calls: 0,
      input_characters: 100,
      output_characters: 32,
      estimated_input_tokens: 25,
      estimated_output_tokens: 8,
    },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function auditEvent(overrides: Partial<MaterialAuditEvent> = {}): MaterialAuditEvent {
  return {
    event_id: '50000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    actor: { type: 'user', id: USER_ID },
    material_id: '30000000-0000-4000-8000-000000000001',
    material_version: 1,
    action: 'material.draft_created',
    occurred_at: NOW,
    changed_fields: ['status'],
    ...overrides,
  };
}

describe('InMemoryMaterialsStore', () => {
  it('round-trips versions and resolves the current (highest) version per tenant', async () => {
    const store = new InMemoryMaterialsStore();
    const v1 = material();
    const v2 = material({ version: 2, status: 'approved', updated_at: '2026-08-01T00:00:00.000Z' });

    await store.saveMaterial(USER_ID, v1);
    await store.saveMaterial(USER_ID, v2);

    expect(await store.hasMaterial(USER_ID, v1.id)).toBe(true);
    expect(await store.hasMaterial(OTHER_USER_ID, v1.id)).toBe(false);
    expect(await store.getCurrentMaterial(USER_ID, v1.id)).toEqual(v2);
    expect(await store.getCurrentMaterial(OTHER_USER_ID, v1.id)).toBeUndefined();
    expect(await store.getMaterialVersion(USER_ID, v1.id, 1)).toEqual(v1);
    expect(
      (await store.listMaterialVersions(USER_ID, v1.id)).map((entry) => entry.version),
    ).toEqual([1, 2]);
    expect((await store.listCurrentMaterials(USER_ID)).map((entry) => entry.id)).toEqual([v1.id]);
    expect(await store.listCurrentMaterials(OTHER_USER_ID)).toEqual([]);
  });

  it('rejects saving the same material id and version twice', async () => {
    const store = new InMemoryMaterialsStore();
    await store.saveMaterial(USER_ID, material());
    await expect(store.saveMaterial(USER_ID, material())).rejects.toThrow();
  });

  it('scopes audit events by tenant', async () => {
    const store = new InMemoryMaterialsStore();
    await store.appendAuditEvent(USER_ID, auditEvent());
    await store.appendAuditEvent(OTHER_USER_ID, auditEvent({ user_id: OTHER_USER_ID }));

    expect((await store.listAuditEvents(USER_ID)).map((event) => event.user_id)).toEqual([USER_ID]);
    expect((await store.listAuditEvents(OTHER_USER_ID)).map((event) => event.user_id)).toEqual([
      OTHER_USER_ID,
    ]);
  });

  it('commits every write inside withTransaction (single in-process store)', async () => {
    const store = new InMemoryMaterialsStore();
    await store.withTransaction(async (scoped) => {
      await scoped.saveMaterial(USER_ID, material());
    });
    expect(await store.getCurrentMaterial(USER_ID, material().id)).toEqual(material());
  });
});
