PRAGMA foreign_keys = ON;

CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  d6e_organization_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
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
  FOREIGN KEY (organization_id) REFERENCES organization(id)
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
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);
