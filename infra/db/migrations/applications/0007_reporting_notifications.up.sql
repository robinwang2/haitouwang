CREATE TABLE reporting_notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  dedupe_key text NOT NULL,
  channel text NOT NULL,
  scheduled_at timestamptz,
  source_ref jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  sent_at timestamptz
);

CREATE INDEX reporting_notifications_user_id_idx
  ON reporting_notifications (user_id, created_at, id);
