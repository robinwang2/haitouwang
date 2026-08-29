CREATE TABLE applications_applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  material_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL,
  submission_idempotency_key text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  timeline jsonb NOT NULL DEFAULT '[]',
  deadline_at timestamptz,
  manual_reason text,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT applications_applications_submission_key_uniq
    UNIQUE (user_id, submission_idempotency_key)
);

CREATE INDEX applications_applications_user_id_idx ON applications_applications (user_id, created_at, id);
