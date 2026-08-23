CREATE TABLE profile_idempotency (
  user_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  audit_event_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation, idempotency_key)
);

CREATE INDEX profile_idempotency_user_id_resource_id_idx ON profile_idempotency (user_id, resource_id);
