ALTER TABLE envelope ADD COLUMN field_generation integer NOT NULL DEFAULT 0;

-- Composite reference target so signing fields can be scoped to the exact
-- organization and envelope of the recipient they are placed for.
ALTER TABLE recipient
  ADD CONSTRAINT recipient_org_envelope_id UNIQUE (organization_id, envelope_id, id);

CREATE TABLE envelope_field (
  id text NOT NULL,
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  document_path text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('signature','initials','text','date','checkbox')),
  label text NOT NULL,
  required boolean NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, envelope_id, recipient_id)
    REFERENCES recipient(organization_id, envelope_id, id),
  CONSTRAINT envelope_field_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

CREATE INDEX envelope_field_document_order
  ON envelope_field(organization_id, envelope_id, document_path, position, id);

CREATE INDEX envelope_field_recipient
  ON envelope_field(organization_id, recipient_id);

CREATE UNIQUE INDEX envelope_field_recipient_document_position
  ON envelope_field(organization_id, envelope_id, recipient_id, document_path, position);

CREATE TABLE envelope_field_placement_command (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expected_generation integer NOT NULL CHECK (expected_generation > 0),
  expected_field_generation integer NOT NULL CHECK (
    expected_field_generation BETWEEN 0 AND 2147483646
  ),
  commit_sha text NOT NULL,
  fields_json text NOT NULL,
  field_count integer NOT NULL CHECK (field_count BETWEEN 1 AND 50),
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);

CREATE INDEX envelope_field_placement_command_envelope
  ON envelope_field_placement_command(organization_id, envelope_id, updated_at DESC);
