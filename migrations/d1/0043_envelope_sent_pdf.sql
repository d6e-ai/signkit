-- The exact, immutable PDF rendering of the revision an envelope was sent
-- at. The Git archive remains the source of truth for history; this is the
-- artifact a recipient is actually shown, and the only surface a signing
-- field's page/x/y geometry can be pinned against.
--
-- The pointer is integrity-pinned three ways -- content-addressed object key,
-- SHA-256, and byte size -- and scoped to (instance, envelope, commit), so
-- a pointer published for one revision can never satisfy a read pinned to
-- another. Page geometry travels with it because a field placed on page 7 is
-- only verifiable against a known page count and document-to-page map.
--
-- Additive: existing columns and rows are untouched. SQLite cannot ALTER a
-- trigger, so envelope_send_publish_guard is recreated verbatim from 0042
-- with two additions -- a fail-closed check that the command carries a
-- pointer, and the insert that publishes it inside the same atomic batch as
-- the status flip and the audit event.

ALTER TABLE envelope_send_command ADD COLUMN sent_pdf_object_key TEXT NULL;
ALTER TABLE envelope_send_command ADD COLUMN sent_pdf_sha256 TEXT NULL;
ALTER TABLE envelope_send_command ADD COLUMN sent_pdf_bytes INTEGER NULL;
ALTER TABLE envelope_send_command ADD COLUMN sent_pdf_page_count INTEGER NULL;
ALTER TABLE envelope_send_command ADD COLUMN sent_pdf_page_width REAL NULL;
ALTER TABLE envelope_send_command ADD COLUMN sent_pdf_page_height REAL NULL;
ALTER TABLE envelope_send_command ADD COLUMN sent_pdf_document_pages_json TEXT NULL;

CREATE TABLE envelope_sent_pdf (
  envelope_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 25165824),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 400),
  page_width REAL NOT NULL CHECK (page_width > 0 AND page_width <= 20000),
  page_height REAL NOT NULL CHECK (page_height > 0 AND page_height <= 20000),
  document_pages_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (envelope_id, commit_sha),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CONSTRAINT envelope_sent_pdf_sha256_hex CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX envelope_sent_pdf_object_key ON envelope_sent_pdf(object_key);

DROP TRIGGER IF EXISTS envelope_send_publish_guard;

CREATE TRIGGER envelope_send_publish_guard
AFTER INSERT ON envelope_send_publish
BEGIN
  -- The send command carries the pinned agreement PDF pointer. Refusing a
  -- publication that lacks one is what keeps "sent" and "there is an exact
  -- rendering of what was sent" the same fact: a recipient can then never be
  -- shown a revision the audit trail does not pin.
  SELECT (CASE WHEN (
      SELECT command.sent_pdf_object_key IS NULL OR command.sent_pdf_sha256 IS NULL
        OR command.sent_pdf_bytes IS NULL OR command.sent_pdf_page_count IS NULL
        OR command.sent_pdf_page_width IS NULL OR command.sent_pdf_page_height IS NULL
        OR command.sent_pdf_document_pages_json IS NULL
      FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
    ) THEN RAISE(ABORT, 'envelope send pdf pointer missing') END);

  UPDATE envelope
  SET status = 'sent', sent_commit_sha = (
        SELECT command.commit_sha FROM envelope_send_command command
        WHERE command.actor_type = NEW.actor_type AND command.actor_id = NEW.actor_id
          AND command.idempotency_key = NEW.idempotency_key
      ), updated_at = (
        SELECT command.updated_at FROM envelope_send_command command
        WHERE command.actor_type = NEW.actor_type AND command.actor_id = NEW.actor_id
          AND command.idempotency_key = NEW.idempotency_key
      )
  WHERE id = (SELECT command.envelope_id FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND status = 'ready'
    AND repository_generation = (SELECT command.expected_generation FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND repository_head = (SELECT command.commit_sha FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND sent_commit_sha IS NULL
    AND EXISTS (
      SELECT 1 FROM envelope_send_command command
      JOIN audit_event previous ON previous.envelope_id = command.envelope_id
        AND previous.sequence = command.audit_sequence - 1
        AND previous.event_hash = command.previous_audit_hash
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
    )
    AND EXISTS (
      SELECT 1 FROM envelope_send_command command
      JOIN envelope_ready_command ready ON ready.envelope_id = command.envelope_id
        AND ready.audit_event_id = command.ready_audit_event_id
        AND ready.expected_generation = command.expected_generation
        AND ready.commit_sha = command.commit_sha
        AND ready.audit_sequence < command.audit_sequence
      JOIN audit_event ready_event ON ready_event.envelope_id = ready.envelope_id
        AND ready_event.id = ready.audit_event_id
        AND ready_event.sequence = ready.audit_sequence
        AND ready_event.event_type = 'envelope.ready'
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM envelope_send_command command
      JOIN audit_event newer ON newer.envelope_id = command.envelope_id AND newer.sequence >= command.audit_sequence
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
    )
    AND (SELECT COUNT(*) FROM delivery_outbox delivery, envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND delivery.envelope_id = command.envelope_id) = (SELECT delivery_count FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND (SELECT COUNT(*) FROM delivery_outbox delivery, envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND delivery.envelope_id = command.envelope_id
        AND delivery.status = 'pending') = (SELECT queued_delivery_count FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND (SELECT COUNT(*) FROM recipient target, envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND target.envelope_id = command.envelope_id
        AND target.role IN ('signer', 'approver', 'viewer')) = (SELECT delivery_count FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key)
    AND NOT EXISTS (
      SELECT 1 FROM delivery_outbox delivery
      JOIN recipient target ON target.id = delivery.recipient_id AND target.envelope_id = delivery.envelope_id
      JOIN envelope_send_command command ON command.envelope_id = delivery.envelope_id
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
        AND (target.role NOT IN ('signer', 'approver', 'viewer')
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
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) SELECT command.audit_event_id, command.envelope_id,
      command.audit_sequence, 'envelope.sent', command.actor_type, command.actor_id,
      command.audit_payload_json, command.previous_audit_hash, command.audit_event_hash,
      command.updated_at, 3
    FROM envelope_send_command command
    WHERE command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key;

  -- Published in the same trigger body, and therefore the same D1 batch, as
  -- the status flip and the audit event: a stale generation, a lost CAS, an
  -- audit conflict, or an idempotency conflict aborts all three together, so
  -- a mismatched pointer is not reachable.
  INSERT INTO envelope_sent_pdf (
    envelope_id, commit_sha, object_key, sha256, byte_size,
    page_count, page_width, page_height, document_pages_json, created_at
  ) SELECT command.envelope_id, command.commit_sha,
      command.sent_pdf_object_key, command.sent_pdf_sha256, command.sent_pdf_bytes,
      command.sent_pdf_page_count, command.sent_pdf_page_width, command.sent_pdf_page_height,
      command.sent_pdf_document_pages_json, command.updated_at
    FROM envelope_send_command command
    WHERE command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key;
END;
