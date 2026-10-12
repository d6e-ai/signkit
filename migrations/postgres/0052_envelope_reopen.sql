-- Guarded ready -> draft reopen before send. Recipients, Git generation, and
-- repository head stay; fields are deleted and field_generation increments.
-- Send adapters require the caller-supplied ready event to remain the latest
-- envelope.ready with no later envelope.reopened.

CREATE TABLE envelope_reopen_command (
  envelope_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expected_generation integer NOT NULL CHECK (expected_generation > 0),
  expected_field_generation integer NOT NULL CHECK (
    expected_field_generation BETWEEN 0 AND 2147483646
  ),
  ready_audit_event_id text NOT NULL,
  commit_sha text NOT NULL,
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (ready_audit_event_id) REFERENCES audit_event(id)
);

CREATE INDEX envelope_reopen_command_envelope
  ON envelope_reopen_command(envelope_id, updated_at DESC);
