import type { HardGate, Job, JobsPageState, JobSource, Score } from './contracts';

export type MatchFilter = 'all' | 'high' | 'medium' | 'low';
export type RiskFilter = 'all' | 'low' | 'medium' | 'high';

export function resolveJobsState(state: JobsPageState, canView: boolean): JobsPageState {
  return canView ? state : 'permission';
}

export function matchBand(total: number): Exclude<MatchFilter, 'all'> {
  if (total >= 80) return 'high';
  if (total >= 60) return 'medium';
  return 'low';
}

export function scoreDecisionLabel(decision: Score['decision'] | string): 'eligible' | 'blocked' | 'manual' | 'unknown' {
  if (decision === 'eligible') return 'eligible';
  if (decision === 'blocked') return 'blocked';
  if (decision === 'manual_review') return 'manual';
  return 'unknown';
}

export function jobCanStartReview(job: Job, score: Score, canEdit: boolean, paused: boolean): boolean {
  return (
    canEdit &&
    !paused &&
    job.status === 'active' &&
    !job.risk.requires_manual_review &&
    job.risk.level !== 'high' &&
    score.decision === 'eligible' &&
    !score.hard_gates.some((gate) => gate.result !== 'pass')
  );
}

export function filterJobs(
  jobs: Job[],
  scores: Score[],
  filters: { query: string; match: MatchFilter; risk: RiskFilter },
): Job[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return jobs.filter((job) => {
    const score = scores.find((item) => item.job_id === job.id);
    const matchesQuery =
      !query || [job.title, job.company, job.location].some((value) => value.toLocaleLowerCase().includes(query));
    const matchesBand = filters.match === 'all' || (score ? matchBand(score.total) === filters.match : false);
    const matchesRisk = filters.risk === 'all' || job.risk.level === filters.risk;
    return matchesQuery && matchesBand && matchesRisk;
  });
}

export function moveJobSelection(currentIndex: number, length: number, key: string): number | null {
  if (length <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return Math.min(currentIndex + 1, length - 1);
  if (key === 'ArrowUp' || key === 'ArrowLeft') return Math.max(currentIndex - 1, 0);
  return null;
}

export function inferJobSource(url: string): JobSource {
  const hostname = new URL(url).hostname.toLocaleLowerCase();
  if (hostname.includes('greenhouse.io')) return 'greenhouse';
  if (hostname === 'jobs.lever.co' || hostname.endsWith('.lever.co')) return 'lever';
  if (hostname.includes('careers') || new URL(url).pathname.toLocaleLowerCase().includes('career')) {
    return 'company_careers';
  }
  return 'manual_url';
}

export function validJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function gateTone(gate: HardGate): 'pass' | 'block' | 'manual' {
  return gate.result;
}
