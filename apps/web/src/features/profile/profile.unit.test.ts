// @ts-expect-error Vitest is intentionally provided by the repository's tooling workspace.
import { describe, expect, it } from 'vitest';
import { mockFacts, mockGoals, mockMaterials } from './mock-api';
import {
  factCanBeUsed,
  factStatusTone,
  materialLabel,
  nextProfileTab,
  resolveProfileState,
  validateGoal,
} from './model';

describe('profile', () => {
  it('does not disguise denied access as empty data', () => {
    expect(resolveProfileState('empty', false)).toBe('permission');
    expect(resolveProfileState('paused', true)).toBe('paused');
    expect(resolveProfileState('error', true)).toBe('error');
  });

  it('supports arrow, Home, and End keyboard navigation between tabs', () => {
    expect(nextProfileTab('onboarding', 'ArrowRight')).toBe('facts');
    expect(nextProfileTab('onboarding', 'ArrowLeft')).toBe('resumes');
    expect(nextProfileTab('facts', 'Home')).toBe('onboarding');
    expect(nextProfileTab('facts', 'End')).toBe('resumes');
    expect(nextProfileTab('facts', 'Enter')).toBeNull();
  });

  it('reports every missing required onboarding contract field', () => {
    expect(validateGoal({ name: '', keywords: ' , ', employmentTypes: [] })).toEqual([
      'name',
      'keywords',
      'employmentTypes',
    ]);
    expect(
      validateGoal({ name: 'Frontend', keywords: 'Engineer', employmentTypes: ['full_time'] }),
    ).toEqual([]);
  });

  it('uses only active and in-scope facts', () => {
    expect(factCanBeUsed(mockFacts.items[0])).toBe(true);
    expect(factCanBeUsed(mockFacts.items[1])).toBe(false);
    expect(factCanBeUsed(mockFacts.items[2])).toBe(false);
    expect(factStatusTone('future_contract_value')).toBe('neutral');
  });

  it('keeps profile mocks aligned with the OpenAPI resource and page shapes', () => {
    expect(mockGoals.page.page_size).toBe(20);
    expect(
      mockGoals.items.every((goal) => goal.version >= 1 && goal.title_keywords.length > 0),
    ).toBe(true);
    expect(
      mockFacts.items.every(
        (fact) => fact.id && fact.user_id && fact.source.reference && fact.version >= 1,
      ),
    ).toBe(true);
    expect(
      mockMaterials.items.every(
        (material) => material.kind === 'resume' && material.file_ids.length > 0,
      ),
    ).toBe(true);
    expect(materialLabel(mockMaterials.items[0])).toBe('base');
    expect(materialLabel(mockMaterials.items[1])).toBe('tailored');
  });
});
