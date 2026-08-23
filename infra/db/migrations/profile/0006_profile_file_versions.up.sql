CREATE TABLE profile_file_versions (
  resource_id uuid NOT NULL REFERENCES profile_files (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL,
  recorded_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (resource_id, version)
);

CREATE INDEX profile_file_versions_user_id_idx ON profile_file_versions (user_id);
