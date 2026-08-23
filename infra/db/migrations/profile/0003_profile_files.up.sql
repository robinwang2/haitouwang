CREATE TABLE profile_files (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  purpose text NOT NULL,
  display_name text NOT NULL,
  media_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  scan_status text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX profile_files_user_id_idx ON profile_files (user_id);
