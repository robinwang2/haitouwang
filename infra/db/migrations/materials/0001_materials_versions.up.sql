CREATE TABLE materials_versions (
  material_id uuid NOT NULL,
  user_id uuid NOT NULL,
  job_id uuid,
  kind text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  file_ids uuid[] NOT NULL DEFAULT '{}',
  supersedes_id uuid,
  document jsonb NOT NULL,
  checks jsonb NOT NULL,
  generation jsonb NOT NULL,
  fact_citations jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (material_id, version)
);

CREATE INDEX materials_versions_user_id_idx ON materials_versions (user_id, material_id, version DESC);
