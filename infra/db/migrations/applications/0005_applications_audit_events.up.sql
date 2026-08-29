CREATE TABLE applications_audit_events (
  event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  actor jsonb NOT NULL,
  action text NOT NULL,
  resource jsonb NOT NULL,
  outcome text NOT NULL,
  from_status text,
  to_status text,
  reason_code text,
  replayed_from_event_id uuid,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX applications_audit_events_user_id_idx
  ON applications_audit_events (user_id, occurred_at, event_id);
