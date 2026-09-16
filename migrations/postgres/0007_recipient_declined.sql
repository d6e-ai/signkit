CREATE TABLE recipient_declined_command (
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
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (recipient_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id)
);

CREATE INDEX recipient_declined_command_envelope
  ON recipient_declined_command(envelope_id, updated_at DESC);
