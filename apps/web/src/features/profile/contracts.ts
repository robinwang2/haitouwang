export type AsyncState = 'loading' | 'ready' | 'empty' | 'error' | 'permission' | 'paused';

export type Goal = {
  id: string;
  user_id: string;
  name: string;
  title_keywords: string[];
  locations: string[];
  employment_types: Array<
    'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary' | 'other'
  >;
  work_authorization_rule?: 'authorized' | 'requires_sponsorship' | 'unknown' | 'manual_only';
  locale?: string;
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
};

export type FactStatus =
  | 'pending_confirmation'
  | 'active'
  | 'expired'
  | 'rejected'
  | 'revoked'
  | 'prohibited'
  | 'deleted';

export type Fact = {
  id: string;
  user_id: string;
  kind:
    | 'identity'
    | 'contact'
    | 'summary'
    | 'experience'
    | 'education'
    | 'skill'
    | 'certification'
    | 'project'
    | 'work_authorization'
    | 'preference';
  value: Record<string, string | number | boolean | null>;
  scope: {
    use: 'all_goals' | 'selected_goals' | 'manual_only' | 'prohibited';
    goal_ids?: string[];
  };
  status: FactStatus;
  source: {
    type: 'user' | 'file' | 'greenhouse' | 'lever' | 'company_careers' | 'manual_url' | 'email' | 'system_rule';
    reference: string;
    captured_at?: string;
    content_hash?: string;
  };
  confirmed_at?: string;
  valid_from?: string;
  valid_until?: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type Material = {
  id: string;
  user_id: string;
  job_id?: string;
  kind: 'resume' | 'cover_letter' | 'open_question_answer' | 'portfolio' | 'other';
  status: 'draft' | 'generating' | 'review_required' | 'approved' | 'rejected' | 'failed' | 'superseded';
  version: number;
  file_ids: string[];
  fact_citations: Array<{
    fact_id: string;
    fact_version: number;
    claim_path: string;
    status?: 'verified' | 'pending_confirmation';
  }>;
  supersedes_id?: string;
  created_at: string;
  updated_at: string;
};

export type CursorPage<T> = {
  items: T[];
  page: { next_cursor: string | null; page_size: number; total_estimate?: number };
};

export type ProfileCapabilities = {
  canView: boolean;
  canEdit: boolean;
};
