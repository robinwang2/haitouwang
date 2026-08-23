CREATE TABLE profile_audit_events (
  event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor jsonb NOT NULL,
  action text NOT NULL,
  resource jsonb NOT NULL,
  outcome text NOT NULL,
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  from_status text,
  to_status text,
  changed_fields text[] NOT NULL,
  reason_code text,
  replayed_from_event_id uuid
);

CREATE INDEX profile_audit_events_user_id_idx ON profile_audit_events (user_id);
