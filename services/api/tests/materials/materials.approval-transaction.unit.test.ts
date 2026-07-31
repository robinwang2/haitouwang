import { describe, expect, it } from 'vitest';

import {
  MaterialsRepository,
  MaterialsService,
  type Material,
  type MaterialsError,
} from '../../src/modules/materials';
import type { Review } from '../../src/modules/review';

import { GOAL_ID, NOW, USER_ID, materialFacts } from './fixtures/material-facts';

describe('server-side material approval gate and transaction', () => {
  it('rejects a direct approval without a persisted eligible Review and audits the gate', () => {
    const service = new MaterialsService();
    const material = generate(service);

    expect(() => approve(service, material, 'missing-review')).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'REVIEW_REQUIRED' }),
    );
    expect(service.get(USER_ID, material.id)).toMatchObject({
      status: 'review_required',
      version: 1,
    });
    expect(service.getAuditEvents(USER_ID).at(-1)).toMatchObject({
      action: 'material.approval_rejected',
      outcome: 'rejected',
      reason_code: 'REVIEW_REQUIRED',
    });
  });

  it('rejects a non-approved Review and an open must-fix finding', () => {
    const service = new MaterialsService();
    const material = generate(service);
    service.saveReview(reviewFor(material, 'requires_changes', 'revise'));

    expect(() => approve(service, material)).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'REVIEW_NOT_APPROVED' }),
    );

    const second = generate(service, '30000000-0000-4000-8000-000000000099');
    service.saveReview(
      reviewFor(second, 'approved', 'approve', [
        {
          id: '70000000-0000-4000-8000-000000000001',
          reviewer: 'fact_check',
          severity: 'must_fix',
          category: 'fabricated_claim',
          message: 'A blocking claim remains unresolved.',
          evidence_refs: [{ type: 'material', id: second.id, version: second.version }],
          status: 'open',
        },
      ]),
    );
    expect(() => approve(service, second)).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'REVIEW_HAS_OPEN_MUST_FIX' }),
    );

    const third = generate(service, '30000000-0000-4000-8000-000000000098');
    service.saveReview(
      reviewFor(third, 'approved', 'approve', [
        {
          id: '70000000-0000-4000-8000-000000000002',
          reviewer: 'ats',
          severity: 'info',
          category: 'snapshot_marker',
          message: 'Review evidence snapshot marker.',
          evidence_refs: [{ type: 'material', id: third.id, version: third.version + 1 }],
          status: 'resolved',
        },
      ]),
    );
    expect(() => approve(service, third)).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'REVIEW_STALE' }),
    );
  });

  it('commits material and success audit together while preserving the approved Review', () => {
    const service = new MaterialsService();
    const material = generate(service);
    const review = service.saveReview(reviewFor(material, 'approved', 'approve'));

    const approved = approve(service, material);

    expect(approved).toMatchObject({ status: 'approved', version: 2 });
    expect(service.getReview(USER_ID, review.id)).toEqual(review);
    expect(service.getAuditEvents(USER_ID).at(-1)).toMatchObject({
      action: 'material.approved',
      outcome: 'succeeded',
      material_version: 2,
    });

    expect(() =>
      service.approve(
        USER_ID,
        approved.id,
        approved.version,
        materialFacts(),
        NOW,
        GOAL_ID,
        review.id,
      ),
    ).toThrowError(expect.objectContaining<Partial<MaterialsError>>({ code: 'REVIEW_STALE' }));
  });

  it('rejects a finding-free Review after the reviewed material is revised', () => {
    const service = new MaterialsService();
    const material = generate(service);
    const review = service.saveReview(reviewFor(material, 'approved', 'approve'));
    const revised = service.revise(USER_ID, material.id, material.version, {
      facts: materialFacts(),
      evaluated_at: NOW,
      goal_id: GOAL_ID,
    });

    expect(() => approve(service, revised, review.id)).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'REVIEW_STALE' }),
    );
    expect(service.get(USER_ID, material.id)).toEqual(revised);
    expect(service.getAuditEvents(USER_ID).at(-1)).toMatchObject({
      action: 'material.approval_rejected',
      reason_code: 'REVIEW_STALE',
    });
  });

  it('rolls back material history, Review and partial audit when the commit fails', () => {
    let failApprovalAudit = false;
    const repository = new MaterialsRepository(':memory:', (kind) => {
      if (kind === 'audit' && failApprovalAudit) {
        failApprovalAudit = false;
        throw new Error('simulated durable audit write failure');
      }
    });
    const service = new MaterialsService(undefined, undefined, repository);
    const material = generate(service);
    const review = service.saveReview(reviewFor(material, 'approved', 'approve'));
    failApprovalAudit = true;

    expect(() => approve(service, material)).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'TRANSACTION_FAILED' }),
    );

    expect(service.get(USER_ID, material.id)).toEqual(material);
    expect(service.getVersions(USER_ID, material.id)).toEqual([material]);
    expect(service.getReview(USER_ID, review.id)).toEqual(review);
    expect(
      service.getAuditEvents(USER_ID).filter((event) => event.action === 'material.approved'),
    ).toEqual([]);
    expect(service.getAuditEvents(USER_ID).at(-1)).toMatchObject({
      action: 'material.approval_failed',
      outcome: 'failed',
      reason_code: 'TRANSACTION_FAILED',
    });
  });

  it('audits successful and rejected rejection transitions', () => {
    const service = new MaterialsService();
    const material = generate(service);

    const rejected = service.reject(USER_ID, material.id, material.version);
    expect(service.getAuditEvents(USER_ID).at(-1)).toMatchObject({
      action: 'material.rejected',
      outcome: 'succeeded',
    });

    expect(() => service.reject(USER_ID, rejected.id, rejected.version)).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'STATE_TRANSITION_INVALID' }),
    );
    expect(service.getAuditEvents(USER_ID).at(-1)).toMatchObject({
      action: 'material.rejection_rejected',
      outcome: 'rejected',
      reason_code: 'STATE_TRANSITION_INVALID',
    });
  });
});

function generate(service: MaterialsService, id = '30000000-0000-4000-8000-000000000001') {
  return service.generate({
    id,
    user_id: USER_ID,
    goal_id: GOAL_ID,
    job_id: '20000000-0000-4000-8000-000000000001',
    kind: 'resume',
    facts: materialFacts(),
    evaluated_at: NOW,
  });
}

function reviewFor(
  material: Material,
  status: Review['status'],
  recommendation: Review['recommendation'],
  findings: Review['findings'] = [],
): Review {
  return {
    id: `60000000-0000-4000-8000-${material.id.slice(-12)}`,
    user_id: USER_ID,
    job_id: material.job_id!,
    material_ids: [material.id],
    material_versions: { [material.id]: material.version },
    status,
    reviewers: ['ats', 'hard_requirements', 'fact_check', 'naturalness'],
    findings,
    recommendation,
    round: 1,
    version: 3,
    created_at: NOW,
    updated_at: NOW,
  };
}

function approve(service: MaterialsService, material: Material, reviewId?: string) {
  return service.approve(
    USER_ID,
    material.id,
    material.version,
    materialFacts(),
    NOW,
    GOAL_ID,
    reviewId ?? `60000000-0000-4000-8000-${material.id.slice(-12)}`,
  );
}
