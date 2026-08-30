-- receipt_id prevents one receipt from producing a second timeline record. receipt_key
-- preserves command-sequence replay detection by agent_id, command_id, and sequence.
CREATE TABLE applications_receipts (
  user_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  receipt_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, receipt_id),
  UNIQUE (user_id, receipt_key)
);
