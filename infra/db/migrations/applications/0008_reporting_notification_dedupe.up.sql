CREATE TABLE reporting_notification_dedupe (
  user_id uuid NOT NULL,
  type text NOT NULL,
  dedupe_key text NOT NULL,
  notification_id uuid NOT NULL,
  PRIMARY KEY (user_id, type, dedupe_key)
);
