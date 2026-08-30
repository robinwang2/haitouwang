CREATE TABLE user_accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  locale text NOT NULL,
  time_zone text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX user_accounts_email_idx ON user_accounts (email);
