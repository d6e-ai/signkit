PRAGMA foreign_keys = ON;

-- Organization identity is the external d6e-auth identifier projected into
-- SignKit. It is deliberately unconstrained text: only SignKit-minted row
-- identifiers are required to be canonical lowercase UUIDv7 (RFC 9562).
-- SQLite has no regular expressions, so every UUIDv7 check below uses the same
-- portable length/separator/GLOB shape, including the version nibble (`7`) and
-- the RFC 9562 variant nibble (`8`, `9`, `a`, or `b`).
CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  d6e_organization_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- SignKit-local instance membership. One deployment database is the instance
-- boundary, so there is no instance_id. user_id is the external d6e-auth
-- subject: d6e-auth proves identity only, and this row is membership
-- authority. Role is owner, admin, or member. Status is active or suspended.
-- No PII is stored. Invite acceptance and bootstrap flows are out of scope
-- for this table.
CREATE TABLE instance_member (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT instance_member_user_id_bound CHECK (
    length(user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_member_role_known CHECK (
    role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT instance_member_status_known CHECK (
    status IN ('active', 'suspended')
  ),
  CONSTRAINT instance_member_created_at_iso CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(created_at) IS NOT NULL
  ),
  CONSTRAINT instance_member_updated_at_iso CHECK (
    length(updated_at) = 24
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(updated_at) IS NOT NULL
  ),
  CONSTRAINT instance_member_updated_order CHECK (
    datetime(updated_at) >= datetime(created_at)
  )
);

CREATE TABLE envelope (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','ready','sent','in_progress','completed','declined','expired','voided')),
  repository_generation INTEGER NOT NULL DEFAULT 0,
  repository_head TEXT,
  repository_archive_key TEXT,
  repository_archive_sha256 TEXT,
  sent_commit_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organization(id),
  CONSTRAINT envelope_id_uuidv7 CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX envelope_org_status_updated ON envelope(organization_id, status, updated_at DESC);

CREATE TABLE audit_event (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  payload_json TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, sequence),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  -- `actor_id` stays unconstrained: it carries an external d6e-auth user ID, a
  -- recipient ID, or a worker name depending on the event type.
  CONSTRAINT audit_event_id_uuidv7 CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  )
);
