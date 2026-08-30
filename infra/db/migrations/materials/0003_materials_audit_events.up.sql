CREATE TABLE materials_audit_events (
  event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  material_id uuid NOT NULL,
  material_version integer NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor jsonb NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  outcome text,
  reason_code text
);

CREATE INDEX materials_audit_events_user_id_idx
  ON materials_audit_events (user_id, occurred_at, event_id);
