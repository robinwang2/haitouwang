import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types test runner requires the explicit TypeScript extension.
import { mockJobs, mockScores } from './mock-api.ts';
import {
  filterJobs,
  inferJobSource,
  jobCanStartReview,
  matchBand,
  moveJobSelection,
  resolveJobsState,
  scoreDecisionLabel,
  validJobUrl,
// @ts-ignore Node's strip-types test runner requires the explicit TypeScript extension.
} from './model.ts';

test('job page states keep permission and paused states explicit', () => {
  assert.equal(resolveJobsState('empty', false), 'permission');
  assert.equal(resolveJobsState('paused', true), 'paused');
  assert.equal(resolveJobsState('loading', true), 'loading');
});

test('job list supports bounded arrow, Home, and End keyboard selection', () => {
  assert.equal(moveJobSelection(0, 3, 'ArrowUp'), 0);
  assert.equal(moveJobSelection(0, 3, 'ArrowDown'), 1);
  assert.equal(moveJobSelection(1, 3, 'Home'), 0);
  assert.equal(moveJobSelection(1, 3, 'End'), 2);
  assert.equal(moveJobSelection(1, 3, 'Enter'), null);
});

test('filters combine keyword, match band, and risk without mutating mocks', () => {
  const originalLength = mockJobs.length;
  assert.deepEqual(
    filterJobs(mockJobs, mockScores, { query: 'northstar', match: 'high', risk: 'low' }).map((job) => job.id),
    [mockJobs[0].id],
  );
  assert.equal(filterJobs(mockJobs, mockScores, { query: '', match: 'all', risk: 'high' })[0].id, mockJobs[2].id);
  assert.equal(mockJobs.length, originalLength);
  assert.equal(matchBand(80), 'high');
  assert.equal(matchBand(60), 'medium');
});

test('URL validation accepts HTTPS and maps supported sources', () => {
  assert.equal(validJobUrl('https://boards.greenhouse.io/acme/jobs/1'), true);
  assert.equal(validJobUrl('javascript:alert(1)'), false);
  assert.equal(validJobUrl('http://jobs.example.com/1'), false);
  assert.equal(inferJobSource('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse');
  assert.equal(inferJobSource('https://jobs.lever.co/acme/1'), 'lever');
  assert.equal(inferJobSource('https://acme.example/careers/1'), 'company_careers');
});

test('hard gates override a high total and unknown decisions stay neutral', () => {
  assert.equal(jobCanStartReview(mockJobs[0], mockScores[0], true, false), true);
  assert.equal(mockScores[2].total > 80, true);
  assert.equal(jobCanStartReview(mockJobs[2], mockScores[2], true, false), false);
  assert.equal(jobCanStartReview(mockJobs[0], mockScores[0], true, true), false);
  assert.equal(scoreDecisionLabel('future_contract_value'), 'unknown');
});

test('job and score mocks satisfy deterministic contract invariants', () => {
  assert.ok(mockJobs.every((job) => job.canonical_url.startsWith('https://') && job.version >= 1));
  assert.ok(mockScores.every((score) => score.dimensions.length === 7 && score.hard_gates.length === 7));
  assert.ok(mockScores.every((score) => /^[a-f0-9]{64}$/.test(score.input_version)));
  assert.ok(mockScores.every((score) => score.dimensions.reduce((total, dimension) => total + dimension.weight, 0) === 100));
});
