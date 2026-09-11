CREATE TABLE recipient_declined_command (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  recipient_role text NOT NULL CHECK (recipient_role IN ('signer','approver')),
  routing_order integer NOT NULL CHECK (routing_order BETWEEN 1 AND 1000),
  actor_type text NOT NULL CHECK (actor_type = 'recipient'),
  actor_id text NOT NULL CHECK (actor_id = recipient_id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  capability_hash text NOT NULL,
  sent_commit_sha text NOT NULL,
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, recipient_id),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id)
);

CREATE INDEX recipient_declined_command_envelope
  ON recipient_declined_command(organization_id, envelope_id, updated_at DESC);
