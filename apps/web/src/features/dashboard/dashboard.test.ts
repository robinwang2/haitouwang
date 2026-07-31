import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types test runner requires the explicit TypeScript extension.
import { mockAgent, mockApplications, mockTasks } from './mock-api.ts';
import {
  activationKey,
  affectedTaskCount,
  agentSafety,
  AUTOMATIC_SUBMISSION_ENABLED,
  buildTodos,
  isVerifiedSubmission,
  resolveDashboardState,
// @ts-ignore Node's strip-types test runner requires the explicit TypeScript extension.
} from './model.ts';

test('dashboard page states fail closed on denied access', () => {
  assert.equal(resolveDashboardState('empty', false), 'permission');
  assert.equal(resolveDashboardState('paused', true), 'paused');
  assert.equal(resolveDashboardState('error', true), 'error');
});

test('automatic submission is permanently disabled in the MVP mock', () => {
  assert.equal(AUTOMATIC_SUBMISSION_ENABLED, false);
});

test('agent safety treats pairing and missing values as unknown, never online', () => {
  assert.equal(agentSafety(mockAgent), 'online');
  assert.equal(agentSafety({ ...mockAgent, status: 'offline' }), 'offline');
  assert.equal(agentSafety({ ...mockAgent, status: 'pairing' }), 'unknown');
  assert.equal(agentSafety(undefined), 'unknown');
});

test('manual handoff and uncertain results sort ahead of confirmation work', () => {
  const todos = buildTodos(mockApplications, mockTasks);
  assert.equal(todos[0].kind, 'manual');
  assert.equal(todos.some((todo) => todo.kind === 'uncertain'), true);
  assert.equal(todos.some((todo) => todo.kind === 'confirm'), true);
  assert.equal(affectedTaskCount(mockTasks), 1);
});

test('submission is counted only with verified evidence', () => {
  const uncertain = mockApplications.find((application) => application.status === 'submitted_pending_verification');
  const submitted = mockApplications.find((application) => application.status === 'submitted');
  assert.equal(uncertain && isVerifiedSubmission(uncertain), false);
  assert.equal(submitted && isVerifiedSubmission(submitted), true);
});

test('switch activation helper recognizes keyboard activation keys', () => {
  assert.equal(activationKey('Enter'), true);
  assert.equal(activationKey(' '), true);
  assert.equal(activationKey('ArrowRight'), false);
});

test('dashboard mocks contain no submitted application without verified evidence', () => {
  assert.ok(mockApplications.every((application) => {
    if (application.status !== 'submitted') return true;
    return application.evidence.some((evidence) => evidence.verified);
  }));
  assert.ok(mockTasks.every((task) => task.attempt <= task.max_attempts));
});
