-- Composite reference target so a submitted field value can be proven, at
-- the foreign-key level, to belong to the exact recipient/envelope/type of
-- the field it claims to answer.
ALTER TABLE envelope_field
  ADD CONSTRAINT envelope_field_identity
  UNIQUE (id, recipient_id, envelope_id, field_type);

-- Field values are declared only in SQL. Each field gets exactly one
-- immutable row for its lifetime (the primary key forbids re-signing), and
-- only a SHA-256 digest of the value ever leaves this table.
CREATE TABLE field_value (
  field_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('signature','initials','text','date','checkbox')),
  value_json text NOT NULL,
  value_sha256 text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (field_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (field_id) REFERENCES envelope_field(id)
);

CREATE INDEX field_value_recipient
  ON field_value(recipient_id);

CREATE TABLE recipient_signed_command (
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
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (recipient_id),
  UNIQUE (audit_event_id),
  UNIQUE (completed_audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id),
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
  ON recipient_signed_command(envelope_id, updated_at DESC);
