-- Organization-scoped workload API keys for agents and the CLI.
-- Raw credentials are signkit_ plus 32 random bytes (base64url). SQL stores only
-- the globally unique SHA-256 token_hash and a non-secret display key_prefix.
-- Create/revoke command receipts keep the request fingerprint and result
-- evidence; they have no token/secret columns. Exact create replay after
-- response loss is already-issued evidence and must never mint or recover
-- another plaintext secret. A later create transaction may upsert a fresh
-- d6e-auth organization before inserting the key row.
CREATE TABLE workload_key (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  rate_window_started_at TEXT,
  rate_window_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organization(id),
  CONSTRAINT workload_key_id_uuidv7 CHECK (
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
  CONSTRAINT workload_key_name_bound CHECK (
    length(name) BETWEEN 1 AND 200
    AND name = trim(name)
    AND substr(name, 1, 8) <> 'signkit_'
  ),
  CONSTRAINT workload_key_token_hash_sha256 CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT workload_key_prefix_display CHECK (
    length(key_prefix) = 16
    AND substr(key_prefix, 1, 8) = 'signkit_'
    AND substr(key_prefix, 9) NOT GLOB '*[^0-9A-Za-z_-]*'
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
    length(created_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT workload_key_created_at_iso CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(created_at) IS NOT NULL
  ),
  CONSTRAINT workload_key_expires_at_iso CHECK (
    length(expires_at) = 24
    AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(expires_at) IS NOT NULL
  ),
  CONSTRAINT workload_key_expiry_bound CHECK (
    datetime(expires_at) > datetime(created_at)
    AND datetime(expires_at) <= datetime(created_at, '+365 days')
  ),
  CONSTRAINT workload_key_revoked_at_order CHECK (
    revoked_at IS NULL OR (
      length(revoked_at) = 24
      AND revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND datetime(revoked_at) IS NOT NULL
      AND datetime(revoked_at) >= datetime(created_at)
    )
  ),
  CONSTRAINT workload_key_last_used_at_order CHECK (
    last_used_at IS NULL OR (
      length(last_used_at) = 24
      AND last_used_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND datetime(last_used_at) IS NOT NULL
      AND datetime(last_used_at) >= datetime(created_at)
    )
  ),
  CONSTRAINT workload_key_rate_window CHECK (
    rate_window_count BETWEEN 0 AND 2147483647
    AND (rate_window_started_at IS NOT NULL OR rate_window_count = 0)
    AND (
      rate_window_started_at IS NULL
      OR (
        length(rate_window_started_at) = 24
        AND rate_window_started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND datetime(rate_window_started_at) IS NOT NULL
        AND datetime(rate_window_started_at) >= datetime(created_at)
      )
    )
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
  organization_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  workload_key_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, workload_key_id),
  FOREIGN KEY (organization_id) REFERENCES organization(id),
  FOREIGN KEY (organization_id, workload_key_id)
    REFERENCES workload_key(organization_id, id),
  CONSTRAINT workload_key_create_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT workload_key_create_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT workload_key_create_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT workload_key_create_name_bound CHECK (
    length(name) BETWEEN 1 AND 200
    AND name = trim(name)
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
    length(key_prefix) = 16
    AND substr(key_prefix, 1, 8) = 'signkit_'
    AND substr(key_prefix, 9) NOT GLOB '*[^0-9A-Za-z_-]*'
  ),
  CONSTRAINT workload_key_create_created_at_iso CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(created_at) IS NOT NULL
  ),
  CONSTRAINT workload_key_create_expires_at_iso CHECK (
    length(expires_at) = 24
    AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(expires_at) IS NOT NULL
  ),
  CONSTRAINT workload_key_create_expiry_bound CHECK (
    datetime(expires_at) > datetime(created_at)
    AND datetime(expires_at) <= datetime(created_at, '+365 days')
  )
);

-- Durable revoke receipt. Stores the request fingerprint and which key was
-- revoked (id + display prefix) without any recoverable secret material.
CREATE TABLE workload_key_revoke_command (
  organization_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  workload_key_id TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, workload_key_id),
  FOREIGN KEY (organization_id) REFERENCES organization(id),
  FOREIGN KEY (organization_id, workload_key_id)
    REFERENCES workload_key(organization_id, id),
  CONSTRAINT workload_key_revoke_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT workload_key_revoke_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT workload_key_revoke_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT workload_key_revoke_prefix_display CHECK (
    length(key_prefix) = 16
    AND substr(key_prefix, 1, 8) = 'signkit_'
    AND substr(key_prefix, 9) NOT GLOB '*[^0-9A-Za-z_-]*'
  ),
  CONSTRAINT workload_key_revoke_revoked_at_iso CHECK (
    length(revoked_at) = 24
    AND revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(revoked_at) IS NOT NULL
  )
);
