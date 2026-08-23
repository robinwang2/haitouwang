CREATE TABLE profile_facts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  value jsonb NOT NULL,
  scope jsonb NOT NULL,
  status text NOT NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  source jsonb NOT NULL,
  confirmed_at timestamptz,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX profile_facts_user_id_idx ON profile_facts (user_id);
