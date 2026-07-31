import type { AddressInfo } from 'node:net';

import { NestFactory, type INestApplication } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MaterialReviewApi } from '../../../../apps/web/src/features/material-review/api';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth.service';
import {
  MaterialsService,
  type Material,
  type MaterialAuditEvent,
} from '../../src/modules/materials';
import type { Review } from '../../src/modules/review';
import { GOAL_ID, NOW, USER_ID, materialFacts } from '../materials/fixtures/material-facts';

describe('real Nest HTTP material-review workflow', () => {
  let app: INestApplication;
  let baseUrl: string;
  let auth: AuthService;
  let materials: MaterialsService;

  beforeEach(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    auth = app.get(AuthService);
    materials = app.get(MaterialsService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('enforces unauthenticated, permission, ownership and valid approver paths at HTTP', async () => {
    const material = seedMaterial(materials);
    const review = materials.saveReview(approvedReview(material));
    const viewer = auth.registerPrincipal({ userId: USER_ID, permissions: ['material:read'] });
    const otherOwner = auth.registerPrincipal({
      userId: '10000000-0000-4000-8000-000000000099',
      permissions: ['material:approve'],
    });
    const approver = auth.registerPrincipal({ userId: USER_ID, permissions: ['material:approve'] });
    const body = approvalBody(material, review);

    expect((await postApproval(material.id, body)).status).toBe(401);
    expect((await postApproval(material.id, body, viewer)).status).toBe(403);
    expect((await postApproval(material.id, body, otherOwner)).status).toBe(404);

    const response = await postApproval(material.id, body, approver);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'approved', version: 2 });
    expect(materials.getAuditEvents('anonymous')).toContainEqual(
      expect.objectContaining({ reason_code: 'UNAUTHENTICATED' }),
    );
    expect(materials.getAuditEvents(USER_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason_code: 'FORBIDDEN' }),
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
    const material = seedMaterial(materials);
    const token = auth.registerPrincipal({ userId: USER_ID, permissions: ['material:approve'] });
    const api = new MaterialReviewApi(baseUrl, token);

    await expect(
      api.approveMaterial(material.id, {
        ...approvalBody(material, approvedReview(material)),
        review_id: '60000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toMatchObject({ status: 412, code: 'REVIEW_REQUIRED' });
  });

  it('covers Web view Review -> resolve must-fix -> approve -> query audit', async () => {
    const material = seedMaterial(materials);
    const review = materials.saveReview(reviewWithMustFix(material));
    const token = auth.registerPrincipal({ userId: USER_ID, permissions: ['material:approve'] });
    const api = new MaterialReviewApi(baseUrl, token);

    const viewed = await api.getReview(review.id);
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

    const audit = await api.listAudit<MaterialAuditEvent>(material.id);
    expect(audit.items).toContainEqual(
      expect.objectContaining({ action: 'material.approved', outcome: 'succeeded' }),
    );
  });
});

function seedMaterial(materials: MaterialsService): Material {
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
