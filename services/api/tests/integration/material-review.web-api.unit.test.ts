import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MaterialReviewApi } from '../../../../apps/web/src/features/material-review/api';
import { AppModule } from '../../src/app.module';
import {
  InMemoryMaterialsStore,
  MATERIALS_STORE,
  MaterialsService,
  type Material,
  type MaterialAuditEvent,
} from '../../src/modules/materials';
import { InMemoryReviewStore, REVIEW_STORE, type Review } from '../../src/modules/review';
import { GOAL_ID, NOW, USER_ID, materialFacts } from '../materials/fixtures/material-facts';

describe('real Nest HTTP material-review workflow', () => {
  let app: INestApplication;
  let baseUrl: string;
  let materials: MaterialsService;
  let materialsStore: InMemoryMaterialsStore;
  let reviewStore: InMemoryReviewStore;
  let failApprovalAudit: boolean;

  beforeEach(async () => {
    process.env.AUTH_JWT_SECRET = testSecret();
    process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;
    failApprovalAudit = false;
    materialsStore = new InMemoryMaterialsStore((kind, value) => {
      if (
        kind === 'audit' &&
        'action' in value &&
        value.action === 'material.approved' &&
        failApprovalAudit
      ) {
        failApprovalAudit = false;
        throw new Error('simulated durable audit failure');
      }
    });
    reviewStore = new InMemoryReviewStore();
    await startApplication();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_AUDIENCE;
  });

  async function startApplication(): Promise<void> {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MATERIALS_STORE)
      .useValue(materialsStore)
      .overrideProvider(REVIEW_STORE)
      .useValue(reviewStore)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    materials = app.get(MaterialsService);
  }

  it('enforces unauthenticated, permission, ownership and valid approver paths at HTTP', async () => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(approvedReview(material));
    const viewer = signToken(USER_ID, ['material:read']);
    const otherOwner = signToken('10000000-0000-4000-8000-000000000099', ['material:approve']);
    const approver = signToken(USER_ID, ['material:approve']);
    const body = approvalBody(material, review);

    expect((await postApproval(material.id, body)).status).toBe(401);
    expect((await postApproval(material.id, body, viewer)).status).toBe(403);
    expect((await postApproval(material.id, body, otherOwner)).status).toBe(404);

    const response = await postApproval(material.id, body, approver);
    expect(response.status).toBe(200);
    const approvedBody = await response.json();
    expectContract('Material', approvedBody);
    expect(approvedBody).toMatchObject({ status: 'approved', version: 2 });
    expect(approvedBody).not.toHaveProperty('document');
    expect(await materials.getAuditEvents(USER_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: { type: 'system', id: 'anonymous' },
          reason_code: 'AUTH_REQUIRED',
        }),
        expect.objectContaining({
          actor: { type: 'user', id: USER_ID },
          reason_code: 'FORBIDDEN',
        }),
        expect.objectContaining({ action: 'material.approved', outcome: 'succeeded' }),
      ]),
    );

    function postApproval(
      materialId: string,
      requestBody: ReturnType<typeof approvalBody>,
      token?: string,
    ) {
      return fetch(`${baseUrl}/v1/materials/${materialId}/approve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(requestBody),
      });
    }
  });

  it('rejects a direct HTTP approval when no qualified Review exists', async () => {
    const material = await seedMaterial(materials);
    const token = signToken(USER_ID, ['material:approve']);
    const api = new MaterialReviewApi(baseUrl, token);

    await expect(
      api.approveMaterial(material.id, {
        ...approvalBody(material, approvedReview(material)),
        review_id: '60000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toMatchObject({ status: 412, code: 'PRECONDITION_REQUIRED' });
  });

  it('rejects a finding-free Review after the reviewed material is revised', async () => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(approvedReview(material));
    const revised = await materials.revise(USER_ID, material.id, material.version, {
      facts: materialFacts(),
      evaluated_at: NOW,
      goal_id: GOAL_ID,
    });

    const response = await fetch(`${baseUrl}/v1/materials/${material.id}/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(USER_ID, ['material:approve'])}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(approvalBody(revised, review)),
    });

    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({
      error: { code: 'PRECONDITION_REQUIRED', retryable: false },
    });
    expect(await materials.get(USER_ID, material.id)).toEqual(revised);
    expect((await materials.getAuditEvents(USER_ID)).at(-1)).toMatchObject({
      action: 'material.approval_rejected',
      reason_code: 'REVIEW_STALE',
    });
  });

  it('audits an invalid rejection body at the HTTP validation boundary', async () => {
    const material = await seedMaterial(materials);
    const response = await fetch(`${baseUrl}/v1/materials/${material.id}/reject`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(USER_ID, ['material:approve'])}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_version: 0 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await materials.get(USER_ID, material.id)).toEqual(material);
    expect((await materials.getAuditEvents(USER_ID)).at(-1)).toMatchObject({
      actor: { type: 'user', id: USER_ID },
      action: 'material.rejection_rejected',
      outcome: 'rejected',
      reason_code: 'VALIDATION_FAILED',
    });
  });

  it('records the actual cross-tenant caller as the rejected audit actor', async () => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(approvedReview(material));
    const otherUserId = '10000000-0000-4000-8000-000000000099';
    const response = await fetch(`${baseUrl}/v1/materials/${material.id}/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(otherUserId, ['material:approve'])}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(approvalBody(material, review)),
    });

    expect(response.status).toBe(404);
    const ownerApi = new MaterialReviewApi(baseUrl, signToken(USER_ID, ['material:read']));
    const audit = await ownerApi.listAudit(material.id);
    expect(audit.items).toContainEqual(
      expect.objectContaining({
        tenant_id: USER_ID,
        actor: { type: 'user', id: otherUserId },
        action: 'material.approval_rejected',
        reason_code: 'RESOURCE_NOT_FOUND',
      }),
    );
  });

  it('covers Web view Review -> resolve must-fix -> approve -> query audit', async () => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(reviewWithMustFix(material));
    const token = signToken(USER_ID, ['material:approve']);
    const api = new MaterialReviewApi(baseUrl, token);

    const viewed = await api.getReview(review.id);
    expectContract('Review', viewed);
    expect(viewed).toMatchObject({ status: 'requires_changes', recommendation: 'revise' });
    expect(viewed.findings[0]).toMatchObject({ severity: 'must_fix', status: 'open' });

    const resolved = await api.resolveFinding(review.id, review.findings[0]!.id);
    expect(resolved).toMatchObject({ status: 'approved', recommendation: 'approve' });
    expect(resolved.findings[0]).toMatchObject({ status: 'resolved' });

    const approved = await api.approveMaterial<Material>(
      material.id,
      approvalBody(material, review),
    );
    expect(approved).toMatchObject({ status: 'approved', version: 2 });
    expectContract('Material', approved);

    const audit = await api.listAudit<MaterialAuditEvent>(material.id);
    for (const event of audit.items) expectContract('AuditEvent', event);
    expect(audit.items).toContainEqual(
      expect.objectContaining({ action: 'material.approved', outcome: 'succeeded' }),
    );
  });

  it('requires review_id and returns contract-valid error envelopes', async () => {
    const material = await seedMaterial(materials);
    await materials.saveReview(approvedReview(material));
    const response = await fetch(`${baseUrl}/v1/materials/${material.id}/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(USER_ID, ['material:approve'])}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expected_version: material.version,
        facts: materialFacts(),
        evaluated_at: NOW,
        goal_id: GOAL_ID,
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({
      error: { code: 'VALIDATION_FAILED', retryable: false },
    });
    expect(await materials.get(USER_ID, material.id)).toEqual(material);
  });

  it('rejects expired, wrong-audience and invalid-signature access tokens', async () => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(approvedReview(material));
    const body = approvalBody(material, review);
    const expired = signToken(USER_ID, ['material:approve'], { expiresInSeconds: -1 });
    const wrongAudience = signToken(USER_ID, ['material:approve'], { audience: 'another-api' });
    const validToken = signToken(USER_ID, ['material:approve']);
    const [invalidHeader, invalidPayload, validSignature] = validToken.split('.');
    const invalidSignature = `${invalidHeader}.${invalidPayload}.${[...validSignature!].reverse().join('')}`;

    for (const [token, status, code] of [
      [expired, 401, 'TOKEN_EXPIRED'],
      [wrongAudience, 403, 'FORBIDDEN'],
      [invalidSignature, 401, 'AUTH_REQUIRED'],
    ] as const) {
      const response = await fetch(`${baseUrl}/v1/materials/${material.id}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
      const errorBody = await response.json();
      expectContract('ErrorEnvelope', errorBody);
      expect(errorBody).toMatchObject({ error: { code } });
    }
  });

  it.each([
    ['missing exp', 'missing'],
    ['string exp', 'string'],
    ['non-integer exp', 'non-integer'],
  ] as const)('rejects %s at the real HTTP boundary', async (_label, expirationKind) => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(approvedReview(material));
    const now = Math.floor(Date.now() / 1000);
    const expirationClaim =
      expirationKind === 'missing'
        ? {}
        : { exp: expirationKind === 'string' ? String(now + 300) : now + 300.5 };
    const token = signClaims({
      sub: USER_ID,
      aud: TEST_AUDIENCE,
      iat: now,
      permissions: ['material:approve'],
      ...expirationClaim,
    });

    const response = await fetch(`${baseUrl}/v1/materials/${material.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(approvalBody(material, review)),
    });
    expect(response.status).toBe(401);
    const errorBody = await response.json();
    expectContract('ErrorEnvelope', errorBody);
    expect(errorBody).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } });
    expect(await materials.get(USER_ID, material.id)).toEqual(material);
    expect((await materials.getAuditEvents(USER_ID)).at(-1)).toMatchObject({
      action: 'material.approval_rejected',
      outcome: 'rejected',
      reason_code: 'TOKEN_EXPIRED',
    });
  });

  it('rolls back durable material and success audit writes after an HTTP persistence failure', async () => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(approvedReview(material));
    failApprovalAudit = true;

    const response = await fetch(`${baseUrl}/v1/materials/${material.id}/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(USER_ID, ['material:approve'])}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(approvalBody(material, review)),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'INTERNAL_ERROR', retryable: true } });
    expect(await materials.get(USER_ID, material.id)).toEqual(material);
    expect(await materials.getReview(USER_ID, review.id)).toEqual(review);
    expect(await materials.getVersions(USER_ID, material.id)).toEqual([material]);
    expect(await materials.getAuditEvents(USER_ID)).not.toContainEqual(
      expect.objectContaining({ action: 'material.approved' }),
    );
    expect(await materials.getAuditEvents(USER_ID)).toContainEqual(
      expect.objectContaining({
        action: 'material.approval_failed',
        outcome: 'failed',
        reason_code: 'TRANSACTION_FAILED',
      }),
    );
  });

  it('persists an atomic approval across an application restart', async () => {
    const material = await seedMaterial(materials);
    const review = await materials.saveReview(approvedReview(material));
    const api = new MaterialReviewApi(baseUrl, signToken(USER_ID, ['material:approve']));
    await api.approveMaterial(material.id, approvalBody(material, review));

    await app.close();
    await startApplication();

    expect(await materials.get(USER_ID, material.id)).toMatchObject({
      status: 'approved',
      version: 2,
    });
    expect(await materials.getReview(USER_ID, review.id)).toEqual(review);
    expect(await materials.getAuditEvents(USER_ID)).toContainEqual(
      expect.objectContaining({ action: 'material.approved', outcome: 'succeeded' }),
    );
  });
});

const TEST_AUDIENCE = 'haitouwang-api-test';

const domainSchema = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../contracts/schemas/domain.schema.json'), 'utf8'),
) as { $id: string };
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(domainSchema);

function expectContract(
  name: 'Material' | 'Review' | 'AuditEvent' | 'ErrorEnvelope',
  value: unknown,
): void {
  const validate = ajv.getSchema(`${domainSchema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Contract validator not found for ${name}.`);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function testSecret(): string {
  return `test-only-auth-${'x'.repeat(32)}`;
}

function signToken(
  userId: string,
  permissions: string[],
  options: { audience?: string; expiresInSeconds?: number } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return signClaims({
    sub: userId,
    aud: options.audience ?? TEST_AUDIENCE,
    iat: now,
    exp: now + (options.expiresInSeconds ?? 300),
    permissions,
  });
}

function signClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', testSecret())
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function seedMaterial(materials: MaterialsService): Promise<Material> {
  return materials.generate({
    id: '30000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    goal_id: GOAL_ID,
    job_id: '20000000-0000-4000-8000-000000000001',
    kind: 'resume',
    facts: materialFacts(),
    evaluated_at: NOW,
  });
}

function approvedReview(material: Material): Review {
  return {
    ...reviewBase(material),
    status: 'approved',
    recommendation: 'approve',
    findings: [],
  };
}

function reviewWithMustFix(material: Material): Review {
  return {
    ...reviewBase(material),
    status: 'requires_changes',
    recommendation: 'revise',
    findings: [
      {
        id: '70000000-0000-4000-8000-000000000001',
        reviewer: 'fact_check',
        severity: 'must_fix',
        category: 'fabricated_claim',
        message: 'Claim needs a traceable rewrite.',
        evidence_refs: [{ type: 'material', id: material.id, version: material.version }],
        status: 'open',
      },
    ],
  };
}

function reviewBase(material: Material): Omit<Review, 'status' | 'recommendation' | 'findings'> {
  return {
    id: '60000000-0000-4000-8000-000000000001',
    user_id: USER_ID,
    job_id: material.job_id!,
    material_ids: [material.id],
    material_versions: { [material.id]: material.version },
    reviewers: ['ats', 'hard_requirements', 'fact_check', 'naturalness'],
    round: 1,
    version: 3,
    created_at: NOW,
    updated_at: NOW,
  };
}

function approvalBody(material: Material, review: Review) {
  return {
    expected_version: material.version,
    facts: materialFacts(),
    evaluated_at: NOW,
    goal_id: GOAL_ID,
    review_id: review.id,
  };
}
