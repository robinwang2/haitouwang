CREATE TABLE review_records (
  review_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  material_ids uuid[] NOT NULL DEFAULT '{}',
  material_versions jsonb NOT NULL,
  status text NOT NULL,
  reviewers text[] NOT NULL DEFAULT '{}',
  findings jsonb NOT NULL,
  recommendation text NOT NULL,
  round integer NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX review_records_user_id_idx ON review_records (user_id, review_id);
