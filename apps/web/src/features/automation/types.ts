export type AutomationCapability = 'search' | 'material_generation' | 'assisted_fill' | 'submit';

export type MutableAutomationCapability = Exclude<AutomationCapability, 'submit'>;

export type ManualReason =
  | 'captcha'
  | 'assessment'
  | 'video_interview'
  | 'electronic_signature'
  | 'unknown_required_field'
  | 'legal_or_identity_question'
  | 'work_authorization_ambiguous'
  | 'page_structure_changed'
  | 'submission_result_uncertain'
  | 'credential_required'
  | 'policy_blocked'
  | 'evidence_conflict';

export type PauseScope = 'global' | 'capability' | 'connection' | 'task';

export interface PauseState {
  readonly scope: PauseScope;
  readonly reason: ManualReason | 'user_requested' | 'agent_offline';
  readonly summary: string;
  readonly recoveryCondition: string;
  readonly capability?: MutableAutomationCapability;
  readonly pausedAt: string;
}

export interface AutomationLimits {
  /**
   * `null` means no approved limit exists. The policy layer treats that as zero
   * executable applications rather than as unlimited.
   */
  readonly dailyApplications: number | null;
  readonly perCompanyApplications: number | null;
  readonly concurrentTasks: number;
}

export interface AutomationSnapshot {
  readonly revision: number;
  readonly loadedAt: string;
  readonly capabilities: Readonly<Record<AutomationCapability, boolean>>;
  readonly limits: AutomationLimits;
  readonly pause: PauseState | null;
  readonly auditEvents: readonly AuditReceipt[];
}

export interface AuditReceipt {
  readonly eventId: string;
  readonly action: string;
  readonly occurredAt: string;
  readonly outcome: 'succeeded';
  readonly changedFields: readonly string[];
}

export interface AutomationPermission {
  readonly canView: boolean;
  readonly canEdit: boolean;
  readonly canOperateAgent: boolean;
}

export type AutomationChange =
  | {
      readonly kind: 'capability';
      readonly capability: MutableAutomationCapability;
      readonly enabled: boolean;
    }
  | {
      readonly kind: 'limits';
      readonly limits: AutomationLimits;
    }
  | {
      readonly kind: 'pause';
      readonly pause: PauseState;
    }
  | {
      readonly kind: 'resume';
    };

export interface ConfirmedAutomationChange {
  readonly expectedRevision: number;
  readonly change: AutomationChange;
  readonly confirmation: {
    readonly impactAcknowledged: true;
    readonly confirmedAt: string;
  };
}

export interface AutomationMutationResult {
  readonly snapshot: AutomationSnapshot;
  /**
   * Every successful change must carry the append-only audit receipt. Clients
   * reject a response without it and keep the previous visible state.
   */
  readonly audit: AuditReceipt;
}

export interface ManualTakeoverTask {
  readonly id: string;
  readonly applicationId: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly sourceUrl: string;
  readonly reason: ManualReason;
  readonly occurredAtStep: string;
  readonly completedActions: readonly string[];
  readonly outstandingActions: readonly string[];
  readonly mayHaveSubmitted: boolean;
  readonly instructions: readonly string[];
  readonly deadline: string | null;
  readonly estimatedMinutes: number;
  readonly status: 'open' | 'still_blocked' | 'completed' | 'abandoned' | 'pending_verification';
}

export type TakeoverResolution =
  | {
      readonly kind: 'completed';
      readonly evidenceReference?: string;
    }
  | {
      readonly kind: 'still_blocked';
      readonly note: string;
    }
  | {
      readonly kind: 'return_to_agent';
    }
  | {
      readonly kind: 'abandon';
    };

export interface TakeoverMutationResult {
  readonly task: ManualTakeoverTask;
  readonly audit: AuditReceipt;
}

export interface AutomationGateway {
  readonly kind: 'production' | 'mock';
  getSnapshot(signal?: AbortSignal): Promise<AutomationSnapshot>;
  applyConfirmedChange(
    request: ConfirmedAutomationChange,
    signal?: AbortSignal,
  ): Promise<AutomationMutationResult>;
  listTakeoverTasks(signal?: AbortSignal): Promise<readonly ManualTakeoverTask[]>;
  resolveTakeoverTask(
    taskId: string,
    resolution: TakeoverResolution,
    signal?: AbortSignal,
  ): Promise<TakeoverMutationResult>;
}
