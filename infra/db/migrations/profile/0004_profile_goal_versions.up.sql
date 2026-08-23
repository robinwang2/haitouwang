CREATE TABLE profile_goal_versions (
  resource_id uuid NOT NULL REFERENCES profile_goals (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL,
  recorded_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (resource_id, version)
);

CREATE INDEX profile_goal_versions_user_id_idx ON profile_goal_versions (user_id);
