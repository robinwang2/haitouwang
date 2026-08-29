CREATE TABLE reporting_reports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  local_date text NOT NULL,
  time_zone text NOT NULL,
  generated_at timestamptz NOT NULL,
  sections jsonb NOT NULL,
  source_record_count integer NOT NULL,
  CONSTRAINT reporting_reports_key_uniq UNIQUE (user_id, local_date, time_zone)
);
