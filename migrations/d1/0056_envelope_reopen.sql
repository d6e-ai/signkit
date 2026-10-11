-- Guarded ready -> draft reopen before send. Recipients, Git generation, and
-- repository head stay; fields are deleted and field_generation increments.
-- The command insert is the D1 compare-and-set boundary: abort rolls the
-- status flip, field delete, and envelope.reopened audit back together.

CREATE TABLE envelope_reopen_command (
  envelope_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  expected_field_generation INTEGER NOT NULL CHECK (
    expected_field_generation BETWEEN 0 AND 2147483646
  ),
  ready_audit_event_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id)
);

CREATE INDEX envelope_reopen_command_envelope
  ON envelope_reopen_command(envelope_id, updated_at DESC);

CREATE TRIGGER envelope_reopen_command_publish
AFTER INSERT ON envelope_reopen_command
BEGIN
  UPDATE envelope
  SET status = 'draft',
      field_generation = NEW.expected_field_generation + 1,
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status = 'ready'
    AND sent_commit_sha IS NULL
    AND repository_generation = NEW.expected_generation
    AND repository_head = NEW.commit_sha
    AND field_generation = NEW.expected_field_generation
    AND EXISTS (
      SELECT 1
      FROM audit_event previous
      WHERE previous.envelope_id = NEW.envelope_id
        AND previous.sequence = NEW.audit_sequence - 1
        AND previous.event_hash = NEW.previous_audit_hash
    )
    AND NOT EXISTS (
      SELECT 1
      FROM audit_event newer
      WHERE newer.envelope_id = NEW.envelope_id
        AND newer.sequence >= NEW.audit_sequence
    )
    AND EXISTS (
      SELECT 1
      FROM envelope_ready_command ready
      JOIN audit_event ready_event ON ready_event.envelope_id = ready.envelope_id
        AND ready_event.id = ready.audit_event_id
        AND ready_event.sequence = ready.audit_sequence
        AND ready_event.event_type = 'envelope.ready'
      WHERE ready.envelope_id = NEW.envelope_id
        AND ready.audit_event_id = NEW.ready_audit_event_id
        AND ready.expected_generation = NEW.expected_generation
        AND ready.commit_sha = NEW.commit_sha
        AND ready.audit_sequence < NEW.audit_sequence
        AND NOT EXISTS (
          SELECT 1
          FROM audit_event later
          WHERE later.envelope_id = NEW.envelope_id
            AND later.sequence > ready.audit_sequence
            AND later.event_type IN ('envelope.ready', 'envelope.reopened')
        )
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope reopen publish conflict')
  END);

  DELETE FROM envelope_field
  WHERE envelope_id = NEW.envelope_id;

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.reopened', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at, 3
  );
END;

-- Recreated from 0045 with a latest-ready guard: a send after reopen/re-ready
-- cannot pin an earlier envelope.ready once a later ready or reopened event
-- exists. SQLite cannot ALTER a trigger.

DROP TRIGGER IF EXISTS envelope_send_publish_guard;

CREATE TRIGGER envelope_send_publish_guard
AFTER INSERT ON envelope_send_publish
BEGIN
  SELECT (CASE WHEN (
      SELECT NOT (
        (
          command.document_set_hash IS NOT NULL AND command.document_count IS NOT NULL
            AND command.sent_documents_json IS NOT NULL
            AND command.sent_pdf_object_key IS NULL AND command.sent_pdf_sha256 IS NULL
            AND command.sent_pdf_bytes IS NULL AND command.sent_pdf_page_count IS NULL
            AND command.sent_pdf_page_width IS NULL AND command.sent_pdf_page_height IS NULL
            AND command.sent_pdf_document_pages_json IS NULL
            AND (
              SELECT COUNT(*) FROM envelope_sent_document docs
              WHERE docs.envelope_id = command.envelope_id
                AND docs.commit_sha = command.commit_sha
            ) = command.document_count
        )
        OR (
          command.sent_pdf_object_key IS NOT NULL AND command.sent_pdf_sha256 IS NOT NULL
            AND command.sent_pdf_bytes IS NOT NULL AND command.sent_pdf_page_count IS NOT NULL
            AND command.sent_pdf_page_width IS NOT NULL AND command.sent_pdf_page_height IS NOT NULL
            AND command.sent_pdf_document_pages_json IS NOT NULL
            AND command.document_set_hash IS NULL AND command.document_count IS NULL
            AND command.sent_documents_json IS NULL
        )
      )
      FROM envelope_send_command command
      WHERE command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
    ) THEN RAISE(ABORT, 'envelope send document set missing') END);

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
        AND NOT EXISTS (
          SELECT 1 FROM audit_event later
          WHERE later.envelope_id = command.envelope_id
            AND later.sequence > ready.audit_sequence
            AND later.event_type IN ('envelope.ready', 'envelope.reopened')
        )
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

  INSERT INTO envelope_sent_document_set (
    envelope_id, commit_sha, document_set_hash, document_count, created_at
  ) SELECT command.envelope_id, command.commit_sha,
      command.document_set_hash, command.document_count, command.updated_at
    FROM envelope_send_command command
    WHERE command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
      AND command.document_set_hash IS NOT NULL;

  INSERT INTO envelope_sent_pdf (
    envelope_id, commit_sha, object_key, sha256, byte_size,
    page_count, page_width, page_height, document_pages_json, created_at
  ) SELECT command.envelope_id, command.commit_sha,
      command.sent_pdf_object_key, command.sent_pdf_sha256, command.sent_pdf_bytes,
      command.sent_pdf_page_count, command.sent_pdf_page_width, command.sent_pdf_page_height,
      command.sent_pdf_document_pages_json, command.updated_at
    FROM envelope_send_command command
    WHERE command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
      AND command.sent_pdf_object_key IS NOT NULL;
END;
