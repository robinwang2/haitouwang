-- The primary key doubles as the idempotency invariant: a second insert of the same
-- (user_id, receipt_id) pair - i.e. the same agent receipt replayed - is rejected by
-- Postgres rather than silently producing a second timeline record.
CREATE TABLE applications_receipts (
  user_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, receipt_id)
);
