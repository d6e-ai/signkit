-- Instance-scoped API keys. instance_member is created in the baseline schema.
-- API keys belong to this SignKit installation, never to a d6e organization.
-- Each key is owned by an instance member. Create/list/revoke require that
-- owner to be currently active at the durable write/query boundary; ownership
-- does not grant organization access. Organization grants for agent requests
-- are deferred. Raw credentials are signkit_ plus 32 random bytes (base64url).
-- SQL stores only the globally unique SHA-256 token_hash and a non-secret
-- display key_prefix. Create/revoke command receipts keep the request
-- fingerprint and result evidence; they have no token/secret columns. Exact
-- create replay after response loss is already-issued evidence and must never
-- mint or recover another plaintext secret. Idempotency is scoped to the
-- actor/owner user plus Idempotency-Key.
CREATE TABLE api_key (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  rate_window_started_at TEXT,
  rate_window_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  FOREIGN KEY (owner_user_id) REFERENCES instance_member(user_id),
  CONSTRAINT api_key_id_uuidv7 CHECK (
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
  CONSTRAINT api_key_name_bound CHECK (
    length(name) BETWEEN 1 AND 200
    AND name = trim(name)
    AND substr(name, 1, 8) <> 'signkit_'
  ),
  CONSTRAINT api_key_token_hash_sha256 CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT api_key_prefix_display CHECK (
    length(key_prefix) = 16
    AND substr(key_prefix, 1, 8) = 'signkit_'
    AND substr(key_prefix, 9) NOT GLOB '*[^0-9A-Za-z_-]*'
  ),
  CONSTRAINT api_key_scopes_canonical CHECK (
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
  CONSTRAINT api_key_created_at_iso CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  CONSTRAINT api_key_expires_at_iso CHECK (
    length(expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  CONSTRAINT api_key_expiry_bound CHECK (
    datetime(expires_at) > datetime(created_at)
    AND datetime(expires_at) <= datetime(created_at, '+365 days')
  ),
  CONSTRAINT api_key_revoked_at_order CHECK (
    revoked_at IS NULL OR (
      length(revoked_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at
      AND datetime(revoked_at) >= datetime(created_at)
    )
  ),
  CONSTRAINT api_key_last_used_at_order CHECK (
    last_used_at IS NULL OR (
      length(last_used_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS last_used_at
      AND datetime(last_used_at) >= datetime(created_at)
    )
  ),
  CONSTRAINT api_key_rate_window CHECK (
    rate_window_count BETWEEN 0 AND 2147483647
    AND (rate_window_started_at IS NOT NULL OR rate_window_count = 0)
    AND (
      rate_window_started_at IS NULL
      OR (
        length(rate_window_started_at) = 24
        AND strftime('%Y-%m-%dT%H:%M:%fZ', rate_window_started_at) IS rate_window_started_at
        AND datetime(rate_window_started_at) >= datetime(created_at)
      )
    )
  )
);

CREATE UNIQUE INDEX api_key_token_hash
  ON api_key(token_hash);

CREATE INDEX api_key_owner_created
  ON api_key(owner_user_id, created_at DESC, id DESC);

-- Durable already-issued record for create. The plaintext secret is returned
-- once in memory and is never stored. A later exact idempotency replay must
-- read this receipt and refuse to mint or recover another secret.
CREATE TABLE api_key_create_command (
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (api_key_id),
  FOREIGN KEY (actor_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (api_key_id) REFERENCES api_key(id),
  CONSTRAINT api_key_create_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT api_key_create_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT api_key_create_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT api_key_create_name_bound CHECK (
    length(name) BETWEEN 1 AND 200
    AND name = trim(name)
    AND substr(name, 1, 8) <> 'signkit_'
  ),
  CONSTRAINT api_key_create_scopes_canonical CHECK (
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
  CONSTRAINT api_key_create_prefix_display CHECK (
    length(key_prefix) = 16
    AND substr(key_prefix, 1, 8) = 'signkit_'
    AND substr(key_prefix, 9) NOT GLOB '*[^0-9A-Za-z_-]*'
  ),
  CONSTRAINT api_key_create_created_at_iso CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  CONSTRAINT api_key_create_expires_at_iso CHECK (
    length(expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  CONSTRAINT api_key_create_expiry_bound CHECK (
    datetime(expires_at) > datetime(created_at)
    AND datetime(expires_at) <= datetime(created_at, '+365 days')
  )
);

-- Durable revoke receipt. Stores the request fingerprint and which key was
-- revoked (id + display prefix) without any recoverable secret material.
CREATE TABLE api_key_revoke_command (
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (api_key_id),
  FOREIGN KEY (actor_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (api_key_id) REFERENCES api_key(id),
  CONSTRAINT api_key_revoke_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT api_key_revoke_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT api_key_revoke_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT api_key_revoke_prefix_display CHECK (
    length(key_prefix) = 16
    AND substr(key_prefix, 1, 8) = 'signkit_'
    AND substr(key_prefix, 9) NOT GLOB '*[^0-9A-Za-z_-]*'
  ),
  CONSTRAINT api_key_revoke_revoked_at_iso CHECK (
    length(revoked_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at
  )
);
