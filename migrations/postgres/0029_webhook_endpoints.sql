CREATE TABLE webhook_endpoint (
  id text NOT NULL,
  url text NOT NULL,
  description text,
  status text NOT NULL,
  events_json text NOT NULL,
  secret_hash text NOT NULL,
  signing_secret text NOT NULL,
  secret_prefix text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_user_id text NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id text,
  PRIMARY KEY (id),
  CONSTRAINT webhook_endpoint_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT webhook_endpoint_status_known CHECK (status IN ('active', 'revoked')),
  CONSTRAINT webhook_endpoint_url_https CHECK (
    char_length(url) BETWEEN 12 AND 2000
    AND url LIKE 'https://%'
  ),
  CONSTRAINT webhook_endpoint_secret_hash_sha256 CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT webhook_endpoint_signing_secret_bound CHECK (
    char_length(signing_secret) BETWEEN 20 AND 80
  ),
  CONSTRAINT webhook_endpoint_secret_prefix_bound CHECK (
    char_length(secret_prefix) BETWEEN 1 AND 32
  ),
  CONSTRAINT webhook_endpoint_terminal_exclusive CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
  )
);

CREATE INDEX webhook_endpoint_org_created
  ON webhook_endpoint(created_at DESC, id DESC);

CREATE TABLE webhook_endpoint_command (
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  request_hash text NOT NULL,
  webhook_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key),
  UNIQUE (webhook_id, command_type),
  FOREIGN KEY (webhook_id) REFERENCES webhook_endpoint(id),
  CONSTRAINT webhook_endpoint_command_type_known CHECK (command_type IN ('create', 'revoke')),
  CONSTRAINT webhook_endpoint_command_request_hash_sha256 CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
