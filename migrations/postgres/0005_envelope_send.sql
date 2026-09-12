CREATE TABLE delivery_outbox (
  id text NOT NULL,
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  kind text NOT NULL CHECK (kind = 'recipient_invitation'),
  status text NOT NULL CHECK (status IN ('blocked','pending','processing','delivered','failed')),
  capability_hash text NOT NULL,
  reserved_capability_expires_at timestamptz,
  sealed_capability text,
  sealing_key_id text NOT NULL,
  sealed_capability_sha256 text NOT NULL,
  available_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at timestamptz,
  delivered_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, recipient_id, kind),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id),
  CHECK (
    (status = 'blocked' AND available_at IS NULL) OR
    (status <> 'blocked' AND available_at IS NOT NULL)
  ),
  CONSTRAINT delivery_outbox_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

CREATE INDEX delivery_outbox_claim
  ON delivery_outbox(status, available_at, created_at)
  WHERE status IN ('pending','failed');

CREATE TABLE envelope_send_command (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expected_generation integer NOT NULL CHECK (expected_generation > 0),
  ready_audit_event_id text NOT NULL,
  commit_sha text NOT NULL,
  initial_routing_order integer NOT NULL CHECK (initial_routing_order BETWEEN 1 AND 1000),
  delivery_count integer NOT NULL CHECK (delivery_count BETWEEN 1 AND 50),
  queued_delivery_count integer NOT NULL CHECK (queued_delivery_count BETWEEN 1 AND delivery_count),
  delivery_manifest_hash text NOT NULL,
  delivery_manifest_json text NOT NULL,
  initial_capability_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, ready_audit_event_id) REFERENCES audit_event(organization_id, id)
);

CREATE INDEX envelope_send_command_envelope
  ON envelope_send_command(organization_id, envelope_id, updated_at DESC);
