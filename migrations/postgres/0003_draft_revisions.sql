CREATE TABLE draft_revision_command (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expected_generation integer NOT NULL,
  resulting_generation integer NOT NULL,
  commit_sha text NOT NULL,
  archive_key text NOT NULL,
  archive_sha256 text NOT NULL,
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL,
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, envelope_id, resulting_generation),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CHECK (resulting_generation = expected_generation + 1),
  CHECK (audit_sequence > 1)
);

CREATE INDEX draft_revision_command_envelope
  ON draft_revision_command(organization_id, envelope_id, resulting_generation DESC);
