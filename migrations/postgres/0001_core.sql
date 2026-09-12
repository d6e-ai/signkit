-- Organization identity is the external d6e-auth identifier projected into
-- SignKit. It is deliberately unconstrained text: only SignKit-minted row
-- identifiers are required to be canonical lowercase UUIDv7 (RFC 9562).
CREATE TABLE organization (
  id text PRIMARY KEY,
  d6e_organization_id text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL
);

-- SignKit-local instance membership. One deployment database is the instance
-- boundary, so there is no instance_id. user_id is the external d6e-auth
-- subject: d6e-auth proves identity only, and this row is membership
-- authority. Role is owner, admin, or member. Status is active or suspended.
-- No PII is stored. Invite acceptance and bootstrap flows are out of scope
-- for this table.
CREATE TABLE instance_member (
  user_id text PRIMARY KEY,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT instance_member_user_id_bound CHECK (
    char_length(user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_member_role_known CHECK (
    role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT instance_member_status_known CHECK (
    status IN ('active', 'suspended')
  ),
  CONSTRAINT instance_member_updated_order CHECK (
    updated_at >= created_at
  )
);

CREATE TABLE envelope (
  id text NOT NULL,
  organization_id text NOT NULL REFERENCES organization(id),
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','ready','sent','in_progress','completed','declined','expired','voided')),
  repository_generation integer NOT NULL DEFAULT 0,
  repository_head text,
  repository_archive_key text,
  repository_archive_sha256 text,
  sent_commit_sha text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  CONSTRAINT envelope_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

CREATE INDEX envelope_org_status_updated ON envelope(organization_id, status, updated_at DESC);

CREATE TABLE audit_event (
  id text NOT NULL,
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  payload_json text NOT NULL,
  previous_hash text,
  event_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, sequence),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  -- `actor_id` stays unconstrained: it carries an external d6e-auth user ID, a
  -- recipient ID, or a worker name depending on the event type.
  CONSTRAINT audit_event_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);
