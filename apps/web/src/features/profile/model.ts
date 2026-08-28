import type { AsyncState, Fact, FactStatus, Material } from './contracts';

export type ProfileTab = 'onboarding' | 'facts' | 'resumes';

const profileTabs: ProfileTab[] = ['onboarding', 'facts', 'resumes'];

export function resolveProfileState(state: AsyncState, canView: boolean): AsyncState {
  return canView ? state : 'permission';
}

export function nextProfileTab(current: ProfileTab, key: string): ProfileTab | null {
  const index = profileTabs.indexOf(current);
  if (key === 'Home') return profileTabs[0];
  if (key === 'End') return profileTabs.at(-1) ?? null;
  if (key === 'ArrowRight' || key === 'ArrowDown')
    return profileTabs[(index + 1) % profileTabs.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return profileTabs[(index - 1 + profileTabs.length) % profileTabs.length];
  }
  return null;
}

export function validateGoal(input: {
  name: string;
  keywords: string;
  employmentTypes: string[];
}): Array<'name' | 'keywords' | 'employmentTypes'> {
  const errors: Array<'name' | 'keywords' | 'employmentTypes'> = [];
  if (!input.name.trim()) errors.push('name');
  if (!input.keywords.split(',').some((keyword) => keyword.trim())) errors.push('keywords');
  if (input.employmentTypes.length === 0) errors.push('employmentTypes');
  return errors;
}

export function factStatusTone(
  status: FactStatus | string,
): 'positive' | 'warning' | 'danger' | 'neutral' {
  if (status === 'active') return 'positive';
  if (status === 'pending_confirmation') return 'warning';
  if (
    status === 'expired' ||
    status === 'prohibited' ||
    status === 'rejected' ||
    status === 'revoked'
  ) {
    return 'danger';
  }
  return 'neutral';
}

export function factCanBeUsed(fact: Fact): boolean {
  if (fact.status !== 'active') return false;
  return fact.scope.use === 'all_goals' || fact.scope.use === 'selected_goals';
}

export function materialLabel(material: Material): 'base' | 'tailored' {
  return material.job_id ? 'tailored' : 'base';
}

export function humanizeFactValue(value: Fact['value']): string {
  return Object.values(value)
    .filter((part) => part !== null && part !== '')
    .join(' · ');
}
