CREATE TABLE recipient (
  id text NOT NULL,
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('signer','approver','viewer','prefill','cc')),
  locale text NOT NULL CHECK (locale IN ('en','ja')),
  routing_order integer NOT NULL CHECK (routing_order BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('pending','viewed','completed','declined')),
  capability_hash text,
  capability_expires_at timestamptz,
  capability_revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, email),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);

CREATE INDEX recipient_envelope_route
  ON recipient(organization_id, envelope_id, routing_order, id);

CREATE UNIQUE INDEX recipient_capability_hash
  ON recipient(capability_hash)
  WHERE capability_hash IS NOT NULL;

CREATE TABLE envelope_ready_command (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expected_generation integer NOT NULL CHECK (expected_generation > 0),
  commit_sha text NOT NULL,
  recipients_json text NOT NULL,
  recipient_count integer NOT NULL CHECK (recipient_count BETWEEN 1 AND 50),
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (organization_id, actor_id, idempotency_key),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);

CREATE INDEX envelope_ready_command_envelope
  ON envelope_ready_command(organization_id, envelope_id, updated_at DESC);
