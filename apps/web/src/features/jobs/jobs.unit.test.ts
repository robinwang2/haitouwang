// @ts-expect-error Vitest is intentionally provided by the repository's tooling workspace.
import { describe, expect, it } from 'vitest';
import { mockJobs, mockScores } from './mock-api';
import {
  filterJobs,
  inferJobSource,
  jobCanStartReview,
  matchBand,
  moveJobSelection,
  resolveJobsState,
  scoreDecisionLabel,
  validJobUrl,
} from './model';

describe('jobs', () => {
  it('keeps permission and paused page states explicit', () => {
    expect(resolveJobsState('empty', false)).toBe('permission');
    expect(resolveJobsState('paused', true)).toBe('paused');
    expect(resolveJobsState('loading', true)).toBe('loading');
  });

  it('supports bounded arrow, Home, and End keyboard selection in the job list', () => {
    expect(moveJobSelection(0, 3, 'ArrowUp')).toBe(0);
    expect(moveJobSelection(0, 3, 'ArrowDown')).toBe(1);
    expect(moveJobSelection(1, 3, 'Home')).toBe(0);
    expect(moveJobSelection(1, 3, 'End')).toBe(2);
    expect(moveJobSelection(1, 3, 'Enter')).toBeNull();
  });

  it('combines keyword, match band, and risk filters without mutating mocks', () => {
    const originalLength = mockJobs.length;
    expect(
      filterJobs(mockJobs, mockScores, { query: 'northstar', match: 'high', risk: 'low' }).map(
        (job) => job.id,
      ),
    ).toEqual([mockJobs[0].id]);
    expect(filterJobs(mockJobs, mockScores, { query: '', match: 'all', risk: 'high' })[0].id).toBe(
      mockJobs[2].id,
    );
    expect(mockJobs).toHaveLength(originalLength);
    expect(matchBand(80)).toBe('high');
    expect(matchBand(60)).toBe('medium');
  });

  it('accepts HTTPS job URLs and maps supported sources', () => {
    expect(validJobUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe(true);
    expect(validJobUrl('javascript:alert(1)')).toBe(false);
    expect(validJobUrl('http://jobs.example.com/1')).toBe(false);
    expect(inferJobSource('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(inferJobSource('https://jobs.lever.co/acme/1')).toBe('lever');
    expect(inferJobSource('https://acme.example/careers/1')).toBe('company_careers');
  });

  it('lets hard gates override a high total and keeps unknown decisions neutral', () => {
    expect(jobCanStartReview(mockJobs[0], mockScores[0], true, false)).toBe(true);
    expect(mockScores[2].total).toBeGreaterThan(80);
    expect(jobCanStartReview(mockJobs[2], mockScores[2], true, false)).toBe(false);
    expect(jobCanStartReview(mockJobs[0], mockScores[0], true, true)).toBe(false);
    expect(scoreDecisionLabel('future_contract_value')).toBe('unknown');
  });

  it('keeps job and score mocks within deterministic contract invariants', () => {
    expect(
      mockJobs.every((job) => job.canonical_url.startsWith('https://') && job.version >= 1),
    ).toBe(true);
    expect(
      mockScores.every((score) => score.dimensions.length === 7 && score.hard_gates.length === 7),
    ).toBe(true);
    expect(mockScores.every((score) => /^[a-f0-9]{64}$/.test(score.input_version))).toBe(true);
    expect(
      mockScores.every(
        (score) =>
          score.dimensions.reduce((total, dimension) => total + dimension.weight, 0) === 100,
      ),
    ).toBe(true);
  });
});
