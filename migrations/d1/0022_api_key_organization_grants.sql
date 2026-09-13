-- Explicit d6e organization grants for instance-scoped API keys.
--
-- API key ownership never implies organization access. An agent request
-- authenticated by a `signkit_` bearer token is authorized against exactly one
-- d6e organization, named by the request's own `SignKit-Organization-Id`
-- selector, and only when a live row in this table grants that key that exact
-- organization. There is no inference from "first grant", "only grant", or any
-- browser cookie: a key with no live grant for the requested organization is
-- refused, and a key with several live grants still reaches only the one it
-- asked for.
--
-- Effective authority is the key's own canonical scopes intersected with the
-- requested live grant. A grant adds an organization and never adds a scope,
-- and it carries no expiry of its own: the owning key's `expires_at` is the
-- only lifetime. Revocation of either side is immediate, because the runtime
-- re-reads token hash, key liveness, owner status, canonical scopes, the
-- requested grant, and the organization projection on every request and caches
-- nothing.
--
-- History is append-only. A grant is revoked by stamping `revoked_at`, never by
-- deletion or by clearing the stamp, and re-granting the same organization
-- mints a brand new row. The partial unique index below therefore constrains
-- only live rows, so (key, organization) can accumulate an ordered sequence of
-- grant/revoke episodes exactly like the delivery outbox accumulates attempts.
--
-- Zero secret material and zero PII: no token, no token hash, no key prefix, no
-- email, and no display name appear in this table or in its receipts. The only
-- identity columns are external d6e-auth subjects, which SignKit already
-- projects in `instance_member`, plus the asserted d6e organization role that
-- authorized the grant.
--
-- Foreign key asymmetry, stated rather than implied:
--   * `granted_by_user_id` REFERENCES instance_member(user_id). Granting
--     requires the caller to own the key, which requires an active local
--     instance member, so the reference always resolves.
--   * `revoked_by_user_id` deliberately carries NO reference. Revocation is
--     de-escalation and has two paths: the key's own active instance-member
--     owner, and a current d6e organization owner/admin for the granted
--     organization. That second actor proves authority entirely through the
--     verified d6e-auth session and need not be a local instance member at all,
--     so requiring the reference would make organization-side revocation
--     impossible for exactly the operator most likely to need it.
CREATE TABLE api_key_organization_grant (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  granted_organization_role TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_user_id TEXT,
  revoked_by_authority TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (api_key_id) REFERENCES api_key(id),
  FOREIGN KEY (organization_id) REFERENCES organization(id),
  FOREIGN KEY (granted_by_user_id) REFERENCES instance_member(user_id),
  CONSTRAINT api_key_organization_grant_id_uuidv7 CHECK (
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
  CONSTRAINT api_key_organization_grant_organization_bound CHECK (
    length(organization_id) BETWEEN 1 AND 200
    AND organization_id NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT api_key_organization_grant_granted_by_bound CHECK (
    length(granted_by_user_id) BETWEEN 1 AND 200
  ),
  -- Only a d6e organization owner or admin may grant. `member` is never
  -- sufficient, so it is not representable here.
  CONSTRAINT api_key_organization_grant_granted_role_known CHECK (
    granted_organization_role IN ('owner', 'admin')
  ),
  CONSTRAINT api_key_organization_grant_granted_at_iso CHECK (
    length(granted_at) = 24
    AND granted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(granted_at) IS NOT NULL
  ),
  CONSTRAINT api_key_organization_grant_revoked_at_order CHECK (
    revoked_at IS NULL OR (
      length(revoked_at) = 24
      AND revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND datetime(revoked_at) IS NOT NULL
      AND datetime(revoked_at) >= datetime(granted_at)
    )
  ),
  CONSTRAINT api_key_organization_grant_revoked_by_bound CHECK (
    revoked_by_user_id IS NULL OR length(revoked_by_user_id) BETWEEN 1 AND 200
  ),
  -- Which de-escalation path retired the grant, as durable evidence.
  CONSTRAINT api_key_organization_grant_revoked_authority_known CHECK (
    revoked_by_authority IS NULL
    OR revoked_by_authority IN ('key_owner', 'organization_admin')
  ),
  -- Revocation is one atomic fact: timestamp, actor, and path arrive together
  -- or not at all, so a half-revoked row can never be read as still live.
  CONSTRAINT api_key_organization_grant_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_authority IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND revoked_by_authority IS NOT NULL)
  )
);

-- At most one live grant per (key, organization). Partial so revoked history
-- accumulates freely, and it is also the hot lookup the request-path
-- authentication snapshot uses.
CREATE UNIQUE INDEX api_key_organization_grant_live
  ON api_key_organization_grant(api_key_id, organization_id)
  WHERE revoked_at IS NULL;

-- Cursor pagination over one key's full grant history, revoked rows included.
CREATE INDEX api_key_organization_grant_key_granted
  ON api_key_organization_grant(api_key_id, granted_at DESC, id DESC);

-- Organization-side lookup for the organization administrator revoke path.
CREATE INDEX api_key_organization_grant_organization_granted
  ON api_key_organization_grant(organization_id, granted_at DESC, id DESC);

-- Durable grant receipt keyed by actor plus Idempotency-Key, mirroring
-- api_key_create_command. It records what was granted and the organization role
-- that authorized it; it holds no token, hash, prefix, or PII.
CREATE TABLE api_key_organization_grant_command (
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  granted_organization_role TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (grant_id),
  FOREIGN KEY (actor_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (grant_id) REFERENCES api_key_organization_grant(id),
  FOREIGN KEY (api_key_id) REFERENCES api_key(id),
  CONSTRAINT api_key_organization_grant_command_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT api_key_organization_grant_command_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT api_key_organization_grant_command_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT api_key_organization_grant_command_organization_bound CHECK (
    length(organization_id) BETWEEN 1 AND 200
    AND organization_id NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT api_key_organization_grant_command_role_known CHECK (
    granted_organization_role IN ('owner', 'admin')
  ),
  CONSTRAINT api_key_organization_grant_command_granted_at_iso CHECK (
    length(granted_at) = 24
    AND granted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(granted_at) IS NOT NULL
  )
);

-- Durable revoke receipt. `actor_id` carries no reference for the same reason
-- api_key_organization_grant.revoked_by_user_id does not: an organization
-- administrator revoking access to their own organization proves authority
-- through d6e-auth and may hold no local instance membership.
CREATE TABLE api_key_organization_grant_revoke_command (
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (grant_id),
  FOREIGN KEY (grant_id) REFERENCES api_key_organization_grant(id),
  FOREIGN KEY (api_key_id) REFERENCES api_key(id),
  CONSTRAINT api_key_organization_grant_revoke_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT api_key_organization_grant_revoke_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT api_key_organization_grant_revoke_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT api_key_organization_grant_revoke_organization_bound CHECK (
    length(organization_id) BETWEEN 1 AND 200
    AND organization_id NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT api_key_organization_grant_revoke_authority_known CHECK (
    actor_authority IN ('key_owner', 'organization_admin')
  ),
  CONSTRAINT api_key_organization_grant_revoke_revoked_at_iso CHECK (
    length(revoked_at) = 24
    AND revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(revoked_at) IS NOT NULL
  )
);

-- D1 has no adapter-visible SERIALIZABLE isolation, so the invariants a
-- PostgreSQL adapter enforces with row locks plus application logic are durable
-- triggers here, matching instance_member_command's approach. These make
-- append-only revocation a property of the table rather than of the adapter.
CREATE TRIGGER api_key_organization_grant_immutable_guard
BEFORE UPDATE ON api_key_organization_grant
BEGIN
  SELECT (CASE
    WHEN NEW.id <> OLD.id
      OR NEW.api_key_id <> OLD.api_key_id
      OR NEW.organization_id <> OLD.organization_id
      OR NEW.granted_by_user_id <> OLD.granted_by_user_id
      OR NEW.granted_organization_role <> OLD.granted_organization_role
      OR NEW.granted_at <> OLD.granted_at
    THEN RAISE(ABORT, 'cannot modify immutable api key organization grant fields')
  END);
  -- Revocation is one-way: NULL may become a stamp, a stamp may never change
  -- or be cleared. An organization grant is never resurrected; re-granting
  -- inserts a new row.
  SELECT (CASE
    WHEN OLD.revoked_at IS NOT NULL AND (
      NEW.revoked_at IS NULL
      OR NEW.revoked_at <> OLD.revoked_at
      OR NEW.revoked_by_user_id IS NOT OLD.revoked_by_user_id
      OR NEW.revoked_by_authority IS NOT OLD.revoked_by_authority
    )
    THEN RAISE(ABORT, 'api key organization grant revocation is immutable')
  END);
END;

CREATE TRIGGER api_key_organization_grant_no_delete_guard
BEFORE DELETE ON api_key_organization_grant
BEGIN
  SELECT RAISE(ABORT, 'api key organization grants cannot be deleted');
END;

CREATE TRIGGER api_key_organization_grant_command_immutable_guard
BEFORE UPDATE ON api_key_organization_grant_command
BEGIN
  SELECT RAISE(ABORT, 'api key organization grant receipts are append-only');
END;

CREATE TRIGGER api_key_organization_grant_command_no_delete_guard
BEFORE DELETE ON api_key_organization_grant_command
BEGIN
  SELECT RAISE(ABORT, 'api key organization grant receipts are append-only');
END;

CREATE TRIGGER api_key_organization_grant_revoke_command_immutable_guard
BEFORE UPDATE ON api_key_organization_grant_revoke_command
BEGIN
  SELECT RAISE(ABORT, 'api key organization grant revoke receipts are append-only');
END;

CREATE TRIGGER api_key_organization_grant_revoke_command_no_delete_guard
BEFORE DELETE ON api_key_organization_grant_revoke_command
BEGIN
  SELECT RAISE(ABORT, 'api key organization grant revoke receipts are append-only');
END;
