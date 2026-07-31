export type JobSource = 'greenhouse' | 'lever' | 'company_careers' | 'manual_url';
export type JobStatus = 'discovered' | 'normalized' | 'risk_review' | 'active' | 'expired' | 'removed';
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export type Job = {
  id: string;
  canonical_url: string;
  source: JobSource;
  source_refs: Array<{
    type: 'user' | 'file' | 'greenhouse' | 'lever' | 'company_careers' | 'manual_url' | 'email' | 'system_rule';
    reference: string;
    captured_at?: string;
    content_hash?: string;
  }>;
  title: string;
  company: string;
  location: string;
  employment_type: 'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary' | 'other' | 'unknown';
  description_status: 'complete' | 'partial' | 'missing';
  risk: {
    level: RiskLevel;
    reasons: string[];
    requires_manual_review: boolean;
  };
  status: JobStatus;
  version: number;
  created_at: string;
  updated_at: string;
};

export type ScoreDimension = {
  name: 'skills' | 'experience' | 'work_authorization' | 'location' | 'salary' | 'employment_type' | 'preference';
  weight: 5 | 10 | 15 | 20 | 25;
  score: number;
  evidence_paths: string[];
};

export type HardGate = {
  name: 'work_authorization' | 'blacklist' | 'duplicate' | 'location' | 'salary' | 'employment_type' | 'risk';
  result: 'pass' | 'block' | 'manual';
  evidence_paths: string[];
};

export type Score = {
  id: string;
  user_id: string;
  goal_id: string;
  job_id: string;
  total: number;
  dimensions: ScoreDimension[];
  hard_gates: HardGate[];
  decision: 'eligible' | 'blocked' | 'manual_review';
  explanations: string[];
  input_version: string;
  created_at: string;
};

export type JobsPageState = 'loading' | 'ready' | 'empty' | 'error' | 'permission' | 'paused';
export type JobsCapabilities = { canView: boolean; canEdit: boolean };
