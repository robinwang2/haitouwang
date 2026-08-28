import assert from 'node:assert/strict';
import test from 'node:test';

import { mockReviewCase } from './mock-data';
import { canApprove, getApprovalBlockers, InMemoryReviewDecisionGateway } from './review-workflow';

const capabilities = { canViewFacts: true, canEdit: true, canDecide: true };
const context = {
  actor: { type: 'user', id: 'test-user' },
  createId: (() => {
    let sequence = 1;
    return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
  })(),
  now: () => new Date('2026-07-31T12:00:00.000Z'),
};

function approvableReview() {
  return {
    ...mockReviewCase,
    findings: mockReviewCase.findings.map((finding) => ({
      ...finding,
      status: 'resolved',
      resolution: 'test revision',
    })),
    questions: mockReviewCase.questions.map((question) => ({ ...question, answer: '10' })),
    evidence: mockReviewCase.evidence.map((evidence) => ({
      ...evidence,
      allowed: true,
      state: 'confirmed',
    })),
  };
}

test('open must-fix item blocks approval and the rejected decision is audited', async () => {
  const gateway = new InMemoryReviewDecisionGateway();
  const blockers = getApprovalBlockers(mockReviewCase, capabilities);

  assert.equal(canApprove(mockReviewCase, capabilities), false);
  assert.ok(blockers.some((blocker) => blocker.code === 'MUST_FIX_OPEN'));

  const result = await gateway.approve(mockReviewCase, capabilities, context);
  assert.equal(result.accepted, false);
  assert.equal(result.review.status, 'requires_changes');
  assert.equal(result.auditEvent.action, 'review.approved');
  assert.equal(result.auditEvent.outcome, 'rejected');
  assert.equal(gateway.auditEvents.length, 1);
});

test('approval succeeds only after every gate passes and writes an audit event', async () => {
  const gateway = new InMemoryReviewDecisionGateway();
  const review = approvableReview();

  assert.equal(canApprove(review, capabilities), true);
  const result = await gateway.approve(review, capabilities, context);

  assert.equal(result.accepted, true);
  assert.equal(result.review.status, 'approved');
  assert.equal(result.auditEvent.action, 'review.approved');
  assert.equal(result.auditEvent.outcome, 'succeeded');
  assert.deepEqual(result.auditEvent.changed_fields, ['status', 'recommendation', 'version']);
});

test('edit, answer, finding resolution, and rejection decisions each append one audit event', async () => {
  const gateway = new InMemoryReviewDecisionGateway();
  const material = mockReviewCase.materials[0];
  const statement = material.statements[0];

  const edited = await gateway.saveMaterialEdit(
    mockReviewCase,
    material.id,
    statement.id,
    'Updated statement',
    context,
  );
  const answered = await gateway.answerQuestion(
    edited.review,
    'question-team-size',
    '确认',
    context,
  );
  const resolved = await gateway.resolveFinding(
    answered.review,
    'finding-team-size',
    'Confirmed team size with the user',
    context,
  );
  const rejected = await gateway.reject(
    resolved.review,
    'POSITIONING_MISMATCH',
    'Use a different version',
    capabilities,
    context,
  );

  assert.equal(edited.accepted, true);
  assert.equal(answered.accepted, true);
  assert.equal(resolved.accepted, true);
  assert.equal(rejected.accepted, true);
  assert.deepEqual(
    gateway.auditEvents.map((event) => event.action),
    [
      'review.material_edited',
      'review.question_answered',
      'review.finding_resolved',
      'review.rejected',
    ],
  );
  assert.ok(gateway.auditEvents.every((event) => event.outcome === 'succeeded'));
});
