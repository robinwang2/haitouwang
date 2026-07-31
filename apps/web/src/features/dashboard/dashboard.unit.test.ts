// @ts-expect-error Vitest is intentionally provided by the repository's tooling workspace.
import { describe, expect, it } from 'vitest';
import { mockAgent, mockApplications, mockTasks } from './mock-api';
import {
  activationKey,
  affectedTaskCount,
  agentSafety,
  AUTOMATIC_SUBMISSION_ENABLED,
  buildTodos,
  isVerifiedSubmission,
  resolveDashboardState,
} from './model';

describe('dashboard', () => {
  it('fails closed on denied access', () => {
    expect(resolveDashboardState('empty', false)).toBe('permission');
    expect(resolveDashboardState('paused', true)).toBe('paused');
    expect(resolveDashboardState('error', true)).toBe('error');
  });

  it('keeps automatic submission permanently disabled in the MVP mock', () => {
    expect(AUTOMATIC_SUBMISSION_ENABLED).toBe(false);
  });

  it('treats pairing and missing agent values as unknown, never online', () => {
    expect(agentSafety(mockAgent)).toBe('online');
    expect(agentSafety({ ...mockAgent, status: 'offline' })).toBe('offline');
    expect(agentSafety({ ...mockAgent, status: 'pairing' })).toBe('unknown');
    expect(agentSafety(undefined)).toBe('unknown');
  });

  it('sorts manual handoff and uncertain results ahead of confirmation work', () => {
    const todos = buildTodos(mockApplications, mockTasks);
    expect(todos[0].kind).toBe('manual');
    expect(todos.some((todo) => todo.kind === 'uncertain')).toBe(true);
    expect(todos.some((todo) => todo.kind === 'confirm')).toBe(true);
    expect(affectedTaskCount(mockTasks)).toBe(1);
  });

  it('counts submissions only when they include verified evidence', () => {
    const uncertain = mockApplications.find(
      (application) => application.status === 'submitted_pending_verification',
    );
    const submitted = mockApplications.find((application) => application.status === 'submitted');
    expect(uncertain && isVerifiedSubmission(uncertain)).toBe(false);
    expect(submitted && isVerifiedSubmission(submitted)).toBe(true);
  });

  it('recognizes switch keyboard activation keys', () => {
    expect(activationKey('Enter')).toBe(true);
    expect(activationKey(' ')).toBe(true);
    expect(activationKey('ArrowRight')).toBe(false);
  });

  it('keeps dashboard mocks within submission and retry contract invariants', () => {
    expect(
      mockApplications.every((application) => {
        if (application.status !== 'submitted') return true;
        return application.evidence.some((evidence) => evidence.verified);
      }),
    ).toBe(true);
    expect(mockTasks.every((task) => task.attempt <= task.max_attempts)).toBe(true);
  });
});
