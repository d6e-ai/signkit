CREATE TABLE organization (
  id text PRIMARY KEY,
  d6e_organization_id text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL
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
  PRIMARY KEY (organization_id, id)
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
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);
