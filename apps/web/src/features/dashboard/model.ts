import type { Agent, Application, DashboardPageState, Task } from './contracts';

export const AUTOMATIC_SUBMISSION_ENABLED = false;

export type TodoKind = 'review' | 'confirm' | 'manual' | 'uncertain';

export type DashboardTodo = {
  id: string;
  kind: TodoKind;
  title: string;
  detail: string;
  updatedAt: string;
  priority: number;
};

export function resolveDashboardState(state: DashboardPageState, canView: boolean): DashboardPageState {
  return canView ? state : 'permission';
}

export function agentSafety(agent: Agent | undefined): 'online' | 'offline' | 'unknown' {
  if (!agent) return 'unknown';
  if (agent.status === 'online') return 'online';
  if (agent.status === 'offline' || agent.status === 'revoked' || agent.status === 'unpaired') return 'offline';
  return 'unknown';
}

export function isVerifiedSubmission(application: Application): boolean {
  return application.status === 'submitted' && application.evidence.some((evidence) => evidence.verified);
}

export function applicationTodoKind(status: Application['status']): TodoKind | null {
  if (status === 'materials_ready' || status === 'approved') return 'review';
  if (status === 'awaiting_confirmation') return 'confirm';
  if (status === 'manual_required') return 'manual';
  if (status === 'submitted_pending_verification') return 'uncertain';
  return null;
}

export function buildTodos(applications: Application[], tasks: Task[]): DashboardTodo[] {
  const applicationItems = applications.flatMap((application) => {
    const kind = applicationTodoKind(application.status);
    if (!kind) return [];
    const priority = kind === 'manual' ? 0 : kind === 'uncertain' ? 1 : kind === 'confirm' ? 2 : 3;
    return [{
      id: application.id,
      kind,
      title: `Application ${application.id.slice(-4)}`,
      detail: application.manual_reason?.replaceAll('_', ' ') ?? application.status.replaceAll('_', ' '),
      updatedAt: application.updated_at,
      priority,
    }];
  });
  const manualTasks = tasks
    .filter((task) => task.status === 'requires_human')
    .map((task) => ({
      id: task.id,
      kind: 'manual' as const,
      title: `${task.type.replaceAll('_', ' ')} ${task.id.slice(-4)}`,
      detail: task.manual_reason?.replaceAll('_', ' ') ?? 'manual action required',
      updatedAt: task.updated_at,
      priority: 0,
    }));
  return [...applicationItems, ...manualTasks].sort(
    (a, b) => a.priority - b.priority || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

export function affectedTaskCount(tasks: Task[]): number {
  return tasks.filter((task) => ['queued', 'leased', 'running'].includes(task.status)).length;
}

export function activationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}
