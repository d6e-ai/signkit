-- Composite reference target so a submitted field value can be proven, at
-- the foreign-key level, to belong to the exact recipient/envelope/type of
-- the field it claims to answer.
ALTER TABLE envelope_field
  ADD CONSTRAINT envelope_field_identity
  UNIQUE (organization_id, id, recipient_id, envelope_id, field_type);

-- Field values are declared only in SQL. Each field gets exactly one
-- immutable row for its lifetime (the primary key forbids re-signing), and
-- only a SHA-256 digest of the value ever leaves this table.
CREATE TABLE field_value (
  organization_id text NOT NULL,
  field_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('signature','initials','text','date','checkbox')),
  value_json text NOT NULL,
  value_sha256 text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, field_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, field_id, recipient_id, envelope_id, field_type)
    REFERENCES envelope_field(organization_id, id, recipient_id, envelope_id, field_type)
);

CREATE INDEX field_value_recipient
  ON field_value(organization_id, recipient_id);

CREATE TABLE recipient_signed_command (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  recipient_role text NOT NULL CHECK (recipient_role = 'signer'),
  routing_order integer NOT NULL CHECK (routing_order BETWEEN 1 AND 1000),
  actor_type text NOT NULL CHECK (actor_type = 'recipient'),
  actor_id text NOT NULL CHECK (actor_id = recipient_id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  capability_hash text NOT NULL,
  sent_commit_sha text NOT NULL,
  expected_field_generation integer NOT NULL CHECK (
    expected_field_generation BETWEEN 0 AND 2147483646
  ),
  field_values_json text NOT NULL,
  field_count integer NOT NULL CHECK (field_count BETWEEN 0 AND 50),
  updated_at timestamptz NOT NULL,
  next_routing_order integer CHECK (
    next_routing_order IS NULL OR (next_routing_order BETWEEN 1 AND 1000 AND next_routing_order > routing_order)
  ),
  next_capability_expires_at timestamptz,
  released_delivery_count integer NOT NULL CHECK (released_delivery_count BETWEEN 0 AND 50),
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  completed_audit_event_id text,
  completed_audit_event_hash text,
  completed_audit_payload_json text,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, recipient_id),
  UNIQUE (organization_id, audit_event_id),
  UNIQUE (organization_id, completed_audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id),
  CHECK (
    (
      completed_audit_event_id IS NULL
      AND completed_audit_event_hash IS NULL
      AND completed_audit_payload_json IS NULL
    ) OR (
      completed_audit_event_id IS NOT NULL
      AND completed_audit_event_hash IS NOT NULL
      AND completed_audit_payload_json IS NOT NULL
      AND completed_audit_event_id <> audit_event_id
      AND next_routing_order IS NULL
      AND next_capability_expires_at IS NULL
      AND released_delivery_count = 0
    )
  ),
  CHECK (
    (
      next_routing_order IS NULL
      AND next_capability_expires_at IS NULL
      AND released_delivery_count = 0
    ) OR (
      next_routing_order IS NOT NULL
      AND next_capability_expires_at IS NOT NULL
      AND released_delivery_count > 0
      AND completed_audit_event_id IS NULL
    )
  )
);

CREATE INDEX recipient_signed_command_envelope
  ON recipient_signed_command(organization_id, envelope_id, updated_at DESC);
