CREATE TABLE reporting_source_records (
  user_id uuid NOT NULL,
  record_id uuid NOT NULL,
  hash text NOT NULL,
  category text NOT NULL,
  source_ref jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  reason_code text,
  PRIMARY KEY (user_id, record_id)
);

CREATE INDEX reporting_source_records_user_id_idx
  ON reporting_source_records (user_id, occurred_at, record_id);
