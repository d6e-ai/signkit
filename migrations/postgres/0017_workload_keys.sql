-- Organization-scoped workload API keys for agents and the CLI.
-- Raw credentials are signkit_ plus 32 random bytes (base64url). SQL stores only
-- the globally unique SHA-256 token_hash and a non-secret display key_prefix.
-- Create/revoke command receipts keep the request fingerprint and result
-- evidence; they have no token/secret columns. Exact create replay after
-- response loss is already-issued evidence and must never mint or recover
-- another plaintext secret. A later create transaction may upsert a fresh
-- d6e-auth organization before inserting the key row.
CREATE TABLE workload_key (
  organization_id text NOT NULL REFERENCES organization(id),
  id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  key_prefix text NOT NULL,
  scopes_json text NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  rate_window_started_at timestamptz,
  rate_window_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, id),
  CONSTRAINT workload_key_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT workload_key_name_bound CHECK (
    char_length(name) BETWEEN 1 AND 200
    AND name = btrim(name)
    AND substr(name, 1, 8) <> 'signkit_'
  ),
  CONSTRAINT workload_key_token_hash_sha256 CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT workload_key_prefix_display CHECK (
    key_prefix ~ '^signkit_[A-Za-z0-9_-]{8}$'
  ),
  CONSTRAINT workload_key_scopes_canonical CHECK (
    scopes_json IN (
      '["audit:read"]',
      '["drafts:write"]',
      '["envelopes:read"]',
      '["envelopes:send"]',
      '["audit:read","drafts:write"]',
      '["audit:read","envelopes:read"]',
      '["audit:read","envelopes:send"]',
      '["drafts:write","envelopes:read"]',
      '["drafts:write","envelopes:send"]',
      '["envelopes:read","envelopes:send"]',
      '["audit:read","drafts:write","envelopes:read"]',
      '["audit:read","drafts:write","envelopes:send"]',
      '["audit:read","envelopes:read","envelopes:send"]',
      '["drafts:write","envelopes:read","envelopes:send"]',
      '["audit:read","drafts:write","envelopes:read","envelopes:send"]'
    )
  ),
  CONSTRAINT workload_key_created_by_bound CHECK (
    char_length(created_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT workload_key_expiry_bound CHECK (
    expires_at > created_at
    AND expires_at <= created_at + INTERVAL '365 days'
  ),
  CONSTRAINT workload_key_revoked_at_order CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  ),
  CONSTRAINT workload_key_last_used_at_order CHECK (
    last_used_at IS NULL OR last_used_at >= created_at
  ),
  CONSTRAINT workload_key_rate_window CHECK (
    rate_window_count BETWEEN 0 AND 2147483647
    AND (rate_window_started_at IS NOT NULL OR rate_window_count = 0)
    AND (rate_window_started_at IS NULL OR rate_window_started_at >= created_at)
  )
);

CREATE UNIQUE INDEX workload_key_token_hash
  ON workload_key(token_hash);

CREATE INDEX workload_key_org_created
  ON workload_key(organization_id, created_at DESC, id DESC);

-- Durable already-issued record for create. The plaintext secret is returned
-- once in memory and is never stored. A later exact idempotency replay must
-- read this receipt and refuse to mint or recover another secret.
CREATE TABLE workload_key_create_command (
  organization_id text NOT NULL REFERENCES organization(id),
  actor_type text NOT NULL CHECK (actor_type = 'user'),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  workload_key_id text NOT NULL,
  name text NOT NULL,
  scopes_json text NOT NULL,
  key_prefix text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, workload_key_id),
  FOREIGN KEY (organization_id, workload_key_id)
    REFERENCES workload_key(organization_id, id),
  CONSTRAINT workload_key_create_actor_bound CHECK (
    char_length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT workload_key_create_idempotency_bound CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key ~ '^[\x21-\x7E]+$'
  ),
  CONSTRAINT workload_key_create_request_hash_sha256 CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT workload_key_create_name_bound CHECK (
    char_length(name) BETWEEN 1 AND 200
    AND name = btrim(name)
    AND substr(name, 1, 8) <> 'signkit_'
  ),
  CONSTRAINT workload_key_create_scopes_canonical CHECK (
    scopes_json IN (
      '["audit:read"]',
      '["drafts:write"]',
      '["envelopes:read"]',
      '["envelopes:send"]',
      '["audit:read","drafts:write"]',
      '["audit:read","envelopes:read"]',
      '["audit:read","envelopes:send"]',
      '["drafts:write","envelopes:read"]',
      '["drafts:write","envelopes:send"]',
      '["envelopes:read","envelopes:send"]',
      '["audit:read","drafts:write","envelopes:read"]',
      '["audit:read","drafts:write","envelopes:send"]',
      '["audit:read","envelopes:read","envelopes:send"]',
      '["drafts:write","envelopes:read","envelopes:send"]',
      '["audit:read","drafts:write","envelopes:read","envelopes:send"]'
    )
  ),
  CONSTRAINT workload_key_create_prefix_display CHECK (
    key_prefix ~ '^signkit_[A-Za-z0-9_-]{8}$'
  ),
  CONSTRAINT workload_key_create_expiry_bound CHECK (
    expires_at > created_at
    AND expires_at <= created_at + INTERVAL '365 days'
  )
);

-- Durable revoke receipt. Stores the request fingerprint and which key was
-- revoked (id + display prefix) without any recoverable secret material.
CREATE TABLE workload_key_revoke_command (
  organization_id text NOT NULL REFERENCES organization(id),
  actor_type text NOT NULL CHECK (actor_type = 'user'),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  workload_key_id text NOT NULL,
  key_prefix text NOT NULL,
  revoked_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, workload_key_id),
  FOREIGN KEY (organization_id, workload_key_id)
    REFERENCES workload_key(organization_id, id),
  CONSTRAINT workload_key_revoke_actor_bound CHECK (
    char_length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT workload_key_revoke_idempotency_bound CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key ~ '^[\x21-\x7E]+$'
  ),
  CONSTRAINT workload_key_revoke_request_hash_sha256 CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT workload_key_revoke_prefix_display CHECK (
    key_prefix ~ '^signkit_[A-Za-z0-9_-]{8}$'
  )
);
