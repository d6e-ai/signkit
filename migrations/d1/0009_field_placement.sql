ALTER TABLE envelope ADD COLUMN field_generation INTEGER NOT NULL DEFAULT 0;

-- Composite reference target so signing fields can be scoped to the exact
-- organization and envelope of the recipient they are placed for.
CREATE UNIQUE INDEX recipient_org_envelope_id
  ON recipient(organization_id, envelope_id, id);

CREATE TABLE envelope_field (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  document_path TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('signature','initials','text','date','checkbox')),
  label TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 100000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, envelope_id, recipient_id)
    REFERENCES recipient(organization_id, envelope_id, id),
  CONSTRAINT envelope_field_id_uuidv7 CHECK (
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

CREATE INDEX envelope_field_document_order
  ON envelope_field(organization_id, envelope_id, document_path, position, id);

CREATE INDEX envelope_field_recipient
  ON envelope_field(organization_id, recipient_id);

CREATE UNIQUE INDEX envelope_field_recipient_document_position
  ON envelope_field(organization_id, envelope_id, recipient_id, document_path, position);

CREATE TABLE envelope_field_placement_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  expected_field_generation INTEGER NOT NULL CHECK (
    expected_field_generation BETWEEN 0 AND 2147483646
  ),
  commit_sha TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  field_count INTEGER NOT NULL CHECK (field_count BETWEEN 1 AND 50),
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);

CREATE INDEX envelope_field_placement_command_envelope
  ON envelope_field_placement_command(organization_id, envelope_id, updated_at DESC);

-- The command insert is the D1 compare-and-set boundary. It flips
-- field_generation and appends the audit event only when the envelope is
-- ready, the caller's generation/head/field-generation are all still
-- current, the audit head has not advanced, and every declared field's
-- recipient is a signer scoped to this organization and envelope. The
-- application replaces the envelope_field projection in the same D1 batch;
-- any later statement failure rolls this trigger, the command, and its
-- audit event back together.
CREATE TRIGGER envelope_field_placement_command_publish
AFTER INSERT ON envelope_field_placement_command
BEGIN
  UPDATE envelope
  SET field_generation = NEW.expected_field_generation + 1,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.envelope_id
    AND status = 'ready'
    AND repository_generation = NEW.expected_generation
    AND repository_head = NEW.commit_sha
    AND field_generation = NEW.expected_field_generation
    AND EXISTS (
      SELECT 1
      FROM audit_event previous
      WHERE previous.organization_id = NEW.organization_id
        AND previous.envelope_id = NEW.envelope_id
        AND previous.sequence = NEW.audit_sequence - 1
        AND previous.event_hash = NEW.previous_audit_hash
    )
    AND NOT EXISTS (
      SELECT 1
      FROM audit_event newer
      WHERE newer.organization_id = NEW.organization_id
        AND newer.envelope_id = NEW.envelope_id
        AND newer.sequence >= NEW.audit_sequence
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.fields_json) field
      WHERE NOT EXISTS (
        SELECT 1
        FROM recipient r
        WHERE r.organization_id = NEW.organization_id
          AND r.envelope_id = NEW.envelope_id
          AND r.id = json_extract(field.value, '$.recipientId')
          AND r.role = 'signer'
      )
    );

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'field placement publish conflict')
  END;

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.fields_placed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );
END;

-- Field placement advances the audit head after envelope.ready. Replace the
-- original send guard so it still chains envelope.sent from the current head,
-- while treating the caller-supplied ready event as an immutable anchor for
-- the same Git generation and commit instead of requiring it to remain HEAD.
DROP TRIGGER envelope_send_publish_guard;

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
    )
    AND EXISTS (
      SELECT 1 FROM envelope_send_command command
      JOIN envelope_ready_command ready ON ready.organization_id = command.organization_id
        AND ready.envelope_id = command.envelope_id
        AND ready.audit_event_id = command.ready_audit_event_id
        AND ready.expected_generation = command.expected_generation
        AND ready.commit_sha = command.commit_sha
        AND ready.audit_sequence < command.audit_sequence
      JOIN audit_event ready_event ON ready_event.organization_id = ready.organization_id
        AND ready_event.envelope_id = ready.envelope_id
        AND ready_event.id = ready.audit_event_id
        AND ready_event.sequence = ready.audit_sequence
        AND ready_event.event_type = 'envelope.ready'
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
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

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope send publish conflict')
  END;

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
