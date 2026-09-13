CREATE TABLE delivery_outbox (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'recipient_invitation'),
  status TEXT NOT NULL CHECK (status IN ('blocked','pending','processing','delivered','failed')),
  capability_hash TEXT NOT NULL,
  reserved_capability_expires_at TEXT,
  sealed_capability TEXT,
  sealing_key_id TEXT NOT NULL,
  sealed_capability_sha256 TEXT NOT NULL,
  available_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TEXT,
  delivered_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, recipient_id, kind),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id),
  CHECK (
    (status = 'blocked' AND available_at IS NULL) OR
    (status <> 'blocked' AND available_at IS NOT NULL)
  ),
  CONSTRAINT delivery_outbox_id_uuidv7 CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX delivery_outbox_claim
  ON delivery_outbox(status, available_at, created_at)
  WHERE status IN ('pending','failed');

CREATE TABLE envelope_send_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  ready_audit_event_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  initial_routing_order INTEGER NOT NULL CHECK (initial_routing_order BETWEEN 1 AND 1000),
  delivery_count INTEGER NOT NULL CHECK (delivery_count BETWEEN 1 AND 50),
  queued_delivery_count INTEGER NOT NULL CHECK (queued_delivery_count BETWEEN 1 AND delivery_count),
  delivery_manifest_hash TEXT NOT NULL,
  delivery_manifest_json TEXT NOT NULL,
  initial_capability_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, ready_audit_event_id) REFERENCES audit_event(organization_id, id)
);

CREATE INDEX envelope_send_command_envelope
  ON envelope_send_command(organization_id, envelope_id, updated_at DESC);

CREATE TABLE envelope_send_publish (
  organization_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  FOREIGN KEY (organization_id, actor_type, actor_id, idempotency_key)
    REFERENCES envelope_send_command(organization_id, actor_type, actor_id, idempotency_key)
);

-- The guard is deliberately the last statement in the application batch. It
-- verifies the complete recipient/outbox projection before making send visible.
CREATE TRIGGER envelope_send_publish_guard
AFTER INSERT ON envelope_send_publish
BEGIN
  UPDATE envelope
  SET status = 'sent', sent_commit_sha = (
        SELECT command.commit_sha FROM envelope_send_command command
        WHERE command.organization_id = NEW.organization_id
          AND command.actor_type = NEW.actor_type AND command.actor_id = NEW.actor_id
          AND command.idempotency_key = NEW.idempotency_key
      ), updated_at = (
        SELECT command.updated_at FROM envelope_send_command command
        WHERE command.organization_id = NEW.organization_id
          AND command.actor_type = NEW.actor_type AND command.actor_id = NEW.actor_id
          AND command.idempotency_key = NEW.idempotency_key
      )
  WHERE organization_id = NEW.organization_id
    AND id = (SELECT command.envelope_id FROM envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND status = 'ready'
    AND repository_generation = (SELECT command.expected_generation FROM envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND repository_head = (SELECT command.commit_sha FROM envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND sent_commit_sha IS NULL
    AND EXISTS (
      SELECT 1 FROM envelope_send_command command
      JOIN audit_event previous ON previous.organization_id = command.organization_id
        AND previous.envelope_id = command.envelope_id
        AND previous.sequence = command.audit_sequence - 1
        AND previous.event_hash = command.previous_audit_hash
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND previous.id = command.ready_audit_event_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM envelope_send_command command
      JOIN audit_event newer ON newer.organization_id = command.organization_id
        AND newer.envelope_id = command.envelope_id AND newer.sequence >= command.audit_sequence
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
    )
    AND (SELECT COUNT(*) FROM delivery_outbox delivery, envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND delivery.organization_id = command.organization_id
        AND delivery.envelope_id = command.envelope_id) = (SELECT delivery_count FROM envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND (SELECT COUNT(*) FROM delivery_outbox delivery, envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND delivery.organization_id = command.organization_id AND delivery.envelope_id = command.envelope_id
        AND delivery.status = 'pending') = (SELECT queued_delivery_count FROM envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND (SELECT COUNT(*) FROM recipient target, envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND target.organization_id = command.organization_id AND target.envelope_id = command.envelope_id
        AND target.role <> 'cc') = (SELECT delivery_count FROM envelope_send_command command
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND NOT EXISTS (
      SELECT 1 FROM delivery_outbox delivery
      JOIN recipient target ON target.organization_id = delivery.organization_id
        AND target.id = delivery.recipient_id AND target.envelope_id = delivery.envelope_id
      JOIN envelope_send_command command ON command.organization_id = delivery.organization_id
        AND command.envelope_id = delivery.envelope_id
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND (target.role = 'cc'
          OR target.status <> 'pending'
          OR delivery.sealed_capability IS NULL
          OR delivery.status NOT IN ('blocked','pending')
          OR target.capability_hash IS NOT delivery.capability_hash
          OR target.capability_expires_at IS NOT delivery.reserved_capability_expires_at
          OR target.capability_revoked_at IS NOT NULL
          OR (delivery.status = 'pending' AND (target.routing_order <> command.initial_routing_order
            OR target.capability_expires_at <> command.initial_capability_expires_at))
          OR (delivery.status = 'blocked' AND (target.routing_order <= command.initial_routing_order
            OR target.capability_expires_at IS NOT NULL)))
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope send publish conflict')
  END);

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) SELECT command.audit_event_id, command.organization_id, command.envelope_id,
      command.audit_sequence, 'envelope.sent', command.actor_type, command.actor_id,
      command.audit_payload_json, command.previous_audit_hash, command.audit_event_hash,
      command.updated_at
    FROM envelope_send_command command
    WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key;
END;
