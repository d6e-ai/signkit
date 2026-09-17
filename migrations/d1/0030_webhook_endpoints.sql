CREATE TABLE webhook_endpoint (
  id TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  events_json TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  secret_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_user_id TEXT,
  PRIMARY KEY (id),
  -- Same portable UUIDv7 shape as 0001_core.sql: a per-character GLOB would
  -- exceed the Cloudflare D1 LIKE/GLOB pattern complexity cap.
  CONSTRAINT webhook_endpoint_id_uuidv7 CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT webhook_endpoint_status_known CHECK (status IN ('active', 'revoked')),
  CONSTRAINT webhook_endpoint_url_https CHECK (
    length(url) BETWEEN 12 AND 2000
    AND url GLOB 'https://*'
  ),
  CONSTRAINT webhook_endpoint_secret_hash_sha256 CHECK (
    length(secret_hash) = 64
    AND secret_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT webhook_endpoint_signing_secret_bound CHECK (
    length(signing_secret) BETWEEN 20 AND 200
  ),
  CONSTRAINT webhook_endpoint_secret_prefix_bound CHECK (
    length(secret_prefix) BETWEEN 1 AND 32
  ),
  CONSTRAINT webhook_endpoint_terminal_exclusive CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
  )
);

CREATE INDEX webhook_endpoint_org_created
  ON webhook_endpoint(created_at DESC, id DESC);

CREATE TABLE webhook_endpoint_command (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key),
  UNIQUE (webhook_id, command_type),
  FOREIGN KEY (webhook_id) REFERENCES webhook_endpoint(id),
  CONSTRAINT webhook_endpoint_command_type_known CHECK (command_type IN ('create', 'revoke')),
  CONSTRAINT webhook_endpoint_command_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER webhook_endpoint_active_cap_guard
BEFORE INSERT ON webhook_endpoint
WHEN NEW.status = 'active'
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*)
      FROM webhook_endpoint
      WHERE status = 'active'
    ) >= 20
    THEN RAISE(ABORT, 'instance active webhook endpoint limit exceeded')
  END);
END;

CREATE TRIGGER webhook_endpoint_active_cap_update_guard
BEFORE UPDATE OF status ON webhook_endpoint
WHEN NEW.status = 'active' AND OLD.status <> 'active'
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*)
      FROM webhook_endpoint
      WHERE status = 'active'
    ) >= 20
    THEN RAISE(ABORT, 'instance active webhook endpoint limit exceeded')
  END);
END;

