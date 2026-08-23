CREATE TABLE profile_goals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  name text NOT NULL,
  title_keywords text[] NOT NULL,
  locations text[] NOT NULL,
  employment_types text[] NOT NULL,
  salary jsonb,
  work_authorization_rule text,
  locale text,
  status text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX profile_goals_user_id_idx ON profile_goals (user_id);
