import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types test runner requires the explicit TypeScript extension.
import { mockFacts, mockGoals, mockMaterials } from './mock-api.ts';
import {
  factCanBeUsed,
  factStatusTone,
  materialLabel,
  nextProfileTab,
  resolveProfileState,
  validateGoal,
// @ts-ignore Node's strip-types test runner requires the explicit TypeScript extension.
} from './model.ts';

test('profile page states do not disguise denied access as empty data', () => {
  assert.equal(resolveProfileState('empty', false), 'permission');
  assert.equal(resolveProfileState('paused', true), 'paused');
  assert.equal(resolveProfileState('error', true), 'error');
});

test('profile tabs support arrow, Home, and End keyboard navigation', () => {
  assert.equal(nextProfileTab('onboarding', 'ArrowRight'), 'facts');
  assert.equal(nextProfileTab('onboarding', 'ArrowLeft'), 'resumes');
  assert.equal(nextProfileTab('facts', 'Home'), 'onboarding');
  assert.equal(nextProfileTab('facts', 'End'), 'resumes');
  assert.equal(nextProfileTab('facts', 'Enter'), null);
});

test('onboarding validation reports every missing required contract field', () => {
  assert.deepEqual(validateGoal({ name: '', keywords: ' , ', employmentTypes: [] }), [
    'name',
    'keywords',
    'employmentTypes',
  ]);
  assert.deepEqual(validateGoal({ name: 'Frontend', keywords: 'Engineer', employmentTypes: ['full_time'] }), []);
});

test('only active and in-scope facts are usable', () => {
  assert.equal(factCanBeUsed(mockFacts.items[0]), true);
  assert.equal(factCanBeUsed(mockFacts.items[1]), false);
  assert.equal(factCanBeUsed(mockFacts.items[2]), false);
  assert.equal(factStatusTone('future_contract_value'), 'neutral');
});

test('profile mocks follow the OpenAPI resource and page shapes', () => {
  assert.equal(mockGoals.page.page_size, 20);
  assert.ok(mockGoals.items.every((goal) => goal.version >= 1 && goal.title_keywords.length > 0));
  assert.ok(mockFacts.items.every((fact) => fact.id && fact.user_id && fact.source.reference && fact.version >= 1));
  assert.ok(mockMaterials.items.every((material) => material.kind === 'resume' && material.file_ids.length > 0));
  assert.equal(materialLabel(mockMaterials.items[0]), 'base');
  assert.equal(materialLabel(mockMaterials.items[1]), 'tailored');
});
