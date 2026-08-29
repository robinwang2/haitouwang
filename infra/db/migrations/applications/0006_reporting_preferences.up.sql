CREATE TABLE reporting_preferences (
  user_id uuid PRIMARY KEY,
  time_zone text NOT NULL,
  enabled_channels text[] NOT NULL DEFAULT '{}',
  unsubscribed_types text[] NOT NULL DEFAULT '{}',
  quiet_hours jsonb,
  muted_until timestamptz
);
