CREATE TABLE applications_manual_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  application_id uuid NOT NULL,
  application_version integer NOT NULL,
  status text NOT NULL,
  manual_reason text NOT NULL,
  package jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX applications_manual_tasks_user_id_idx
  ON applications_manual_tasks (user_id, application_id, created_at, id);
