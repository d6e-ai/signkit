-- Per-document sent artifacts replace the single concatenated envelope_sent_pdf
-- pointer for newly sent envelopes. envelope_sent_pdf is kept: its rows are
-- frozen evidence for envelopes already sent, and recipients may be mid-signature
-- against them. envelope_send_command keeps the seven sent_pdf_* columns so a
-- pre-migration send receipt can still reconstruct its envelope.sent payload
-- byte-for-byte; new sends store document_set_hash, document_count, and
-- sent_documents_json instead.
--
-- Fields become document_id-scoped. SQLite cannot DROP NOT NULL, so envelope_field
-- is rebuilt with defer_foreign_keys, matching 0036. Triggers that SELECT from
-- envelope_field must be dropped before DROP TABLE and recreated afterwards:
-- otherwise SQLite reports `error in trigger …: no such table main.envelope_field`.
-- Exactly one of document_id and document_path is set.
--
-- field_value has a composite FK into envelope_field and is rebuilt alongside
-- it rather than left alone: see the comment above field_value_new below for
-- why leaving it pointed at a table this migration drops and recreates is
-- not safe to depend on.
--
-- SQLite cannot ALTER a trigger, so envelope_send_publish_guard is dropped
-- (0043 still requires sent_pdf_object_key) and recreated to require either a
-- complete document-set receipt (hash/count/sent_documents_json, with
-- count(envelope_sent_document) matching) or a complete legacy sent_pdf_*
-- receipt, never a partial or mixed combination of the two. The still-serving
-- pre-migration Worker only ever writes the legacy shape, so its sends keep
-- publishing during rollout; legacy rows already committed keep their
-- sent_pdf_* values and are never re-inserted through this trigger.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE envelope_sent_document (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  document_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  kind TEXT NOT NULL CHECK (kind IN ('markdown', 'pdf')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 25165824),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 400),
  page_width REAL NOT NULL CHECK (page_width > 0 AND page_width <= 20000),
  page_height REAL NOT NULL CHECK (page_height > 0 AND page_height <= 20000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, envelope_id, commit_sha, document_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CONSTRAINT envelope_sent_document_id_uuidv7 CHECK (
    length(document_id) = 36
    AND substr(document_id, 9, 1) = '-'
    AND substr(document_id, 14, 1) = '-'
    AND substr(document_id, 15, 1) = '7'
    AND substr(document_id, 19, 1) = '-'
    AND substr(document_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(document_id, 24, 1) = '-'
    AND length(replace(document_id, '-', '')) = 32
    AND replace(document_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT envelope_sent_document_sha256_hex CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT envelope_sent_document_position_unique UNIQUE (
    organization_id, envelope_id, commit_sha, position
  )
);

CREATE INDEX envelope_sent_document_object_key ON envelope_sent_document(object_key);

CREATE TABLE envelope_sent_document_set (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  document_set_hash TEXT NOT NULL,
  document_count INTEGER NOT NULL CHECK (document_count BETWEEN 1 AND 20),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, envelope_id, commit_sha),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CONSTRAINT envelope_sent_document_set_hash_hex CHECK (
    length(document_set_hash) = 64 AND document_set_hash NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE envelope_field_new (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  document_id TEXT NULL,
  document_path TEXT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('signature','initials','text','date','checkbox')),
  label TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 100000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  page INTEGER NULL CHECK (page IS NULL OR page BETWEEN 1 AND 100000),
  x REAL NULL CHECK (x IS NULL OR (x >= 0 AND x <= 1)),
  y REAL NULL CHECK (y IS NULL OR (y >= 0 AND y <= 1)),
  width REAL NULL CHECK (width IS NULL OR (width > 0 AND width <= 1)),
  height REAL NULL CHECK (height IS NULL OR (height > 0 AND height <= 1)),
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
  ),
  CONSTRAINT envelope_field_document_id_uuidv7 CHECK (
    document_id IS NULL
    OR (
      length(document_id) = 36
      AND substr(document_id, 9, 1) = '-'
      AND substr(document_id, 14, 1) = '-'
      AND substr(document_id, 15, 1) = '7'
      AND substr(document_id, 19, 1) = '-'
      AND substr(document_id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(document_id, 24, 1) = '-'
      AND length(replace(document_id, '-', '')) = 32
      AND replace(document_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT envelope_field_document_scope CHECK (
    (document_id IS NULL) <> (document_path IS NULL)
  )
);

INSERT INTO envelope_field_new (
  id, organization_id, envelope_id, recipient_id, document_id, document_path,
  field_type, label, required, position, created_at, updated_at,
  page, x, y, width, height
)
SELECT
  id, organization_id, envelope_id, recipient_id, NULL, document_path,
  field_type, label, required, position, created_at, updated_at,
  page, x, y, width, height
FROM envelope_field;

-- field_value has a composite FK into envelope_field (via the
-- envelope_field_identity unique index). Rebuilding envelope_field alone
-- would leave field_value pointed at a dropped/recreated parent for part of
-- this transaction; whether that survives to COMMIT depends on D1's SQLite
-- build honoring defer_foreign_keys across a DROP+RENAME of the referenced
-- table, which is not safe to depend on. Rebuild field_value in lockstep
-- instead: field_value_new is created and populated while it can still
-- reference envelope_field_new directly (which already holds every row and
-- the unique index its FK needs), so its parent reference is satisfiable at
-- every point, deferred or not. envelope_field is dropped only once nothing
-- named "envelope_field" or "field_value" has a live row referencing it, and
-- ALTER TABLE RENAME rewrites REFERENCES clauses that name a renamed table,
-- so renaming envelope_field_new to envelope_field carries field_value_new's
-- FK along with it.
CREATE UNIQUE INDEX envelope_field_new_identity
  ON envelope_field_new(organization_id, id, recipient_id, envelope_id, field_type);

CREATE TABLE field_value_new (
  organization_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('signature','initials','text','date','checkbox')),
  value_json TEXT NOT NULL,
  value_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, field_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, field_id, recipient_id, envelope_id, field_type)
    REFERENCES envelope_field_new(organization_id, id, recipient_id, envelope_id, field_type)
);

INSERT INTO field_value_new (
  organization_id, field_id, envelope_id, recipient_id, field_type,
  value_json, value_sha256, created_at
)
SELECT
  organization_id, field_id, envelope_id, recipient_id, field_type,
  value_json, value_sha256, created_at
FROM field_value;

-- Drop dependent triggers that reference envelope_field before rebuild.
DROP TRIGGER IF EXISTS recipient_signed_command_publish;

DROP TABLE field_value;
DROP TABLE envelope_field;
ALTER TABLE envelope_field_new RENAME TO envelope_field;
ALTER TABLE field_value_new RENAME TO field_value;

DROP INDEX envelope_field_new_identity;

CREATE INDEX envelope_field_document_order
  ON envelope_field(organization_id, envelope_id, document_id, position, id)
  WHERE document_id IS NOT NULL;

CREATE INDEX envelope_field_document_path_order
  ON envelope_field(organization_id, envelope_id, document_path, position, id)
  WHERE document_path IS NOT NULL;

CREATE INDEX envelope_field_recipient
  ON envelope_field(organization_id, recipient_id);

CREATE UNIQUE INDEX envelope_field_recipient_document_id_position
  ON envelope_field(organization_id, envelope_id, recipient_id, document_id, position)
  WHERE document_id IS NOT NULL;

CREATE UNIQUE INDEX envelope_field_recipient_document_path_position
  ON envelope_field(organization_id, envelope_id, recipient_id, document_path, position)
  WHERE document_path IS NOT NULL;

CREATE UNIQUE INDEX envelope_field_identity
  ON envelope_field(organization_id, id, recipient_id, envelope_id, field_type);

CREATE INDEX field_value_recipient
  ON field_value(organization_id, recipient_id);

-- Restored from 0036_capability_reissue.sql. Recreated command triggers must
-- stamp audit_event.hash_version = 2 explicitly.
CREATE TRIGGER recipient_signed_command_publish
AFTER INSERT ON recipient_signed_command
BEGIN
  UPDATE recipient
  SET status = 'completed',
      capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.recipient_id
    AND envelope_id = NEW.envelope_id
    AND status = 'viewed'
    AND role = 'signer'
    AND role = NEW.recipient_role
    AND routing_order = NEW.routing_order
    AND capability_hash = NEW.capability_hash
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NOT NULL
    AND julianday(capability_expires_at) > julianday(NEW.updated_at);

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope
      WHERE organization_id = NEW.organization_id
        AND id = NEW.envelope_id
        AND field_generation = NEW.expected_field_generation
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN json_array_length(NEW.field_values_json) <> NEW.field_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN (
      SELECT COUNT(*) FROM envelope_field
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND recipient_id = NEW.recipient_id
    ) <> NEW.field_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.field_values_json) declared
      WHERE NOT EXISTS (
        SELECT 1 FROM envelope_field field
        WHERE field.organization_id = NEW.organization_id
          AND field.envelope_id = NEW.envelope_id
          AND field.recipient_id = NEW.recipient_id
          AND field.id = json_extract(declared.value, '$.id')
          AND field.field_type = json_extract(declared.value, '$.fieldType')
      )
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       julianday(NEW.next_capability_expires_at) <= julianday(NEW.updated_at)
       OR julianday(NEW.next_capability_expires_at) > julianday(NEW.updated_at, '+15 days')
     )
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NULL
     AND NEW.completed_audit_event_id IS NULL
     AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       SELECT MIN(routing_order) FROM recipient
       WHERE organization_id = NEW.organization_id
         AND envelope_id = NEW.envelope_id
         AND role IN ('signer', 'approver')
         AND status <> 'completed'
         AND routing_order > NEW.routing_order
     ) IS NOT NEW.next_routing_order
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  UPDATE recipient
  SET capability_expires_at = NEW.next_capability_expires_at,
      updated_at = NEW.updated_at
  WHERE NEW.next_routing_order IS NOT NULL
    AND organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
    AND routing_order = NEW.next_routing_order
    AND role IN ('signer', 'approver', 'viewer')
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NULL;

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL AND changes() <> NEW.released_delivery_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  UPDATE delivery_outbox
  SET status = 'pending',
      reserved_capability_expires_at = NEW.next_capability_expires_at,
      available_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE NEW.next_routing_order IS NOT NULL
    AND organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
    AND status = 'blocked'
    AND available_at IS NULL
    AND sealed_capability IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM recipient target
      WHERE target.organization_id = delivery_outbox.organization_id
        AND target.id = delivery_outbox.recipient_id
        AND target.envelope_id = delivery_outbox.envelope_id
        AND target.routing_order = NEW.next_routing_order
        AND target.role IN ('signer', 'approver', 'viewer')
        AND target.status <> 'completed'
        AND target.capability_revoked_at IS NULL
        AND target.capability_expires_at = NEW.next_capability_expires_at
        AND target.capability_hash = delivery_outbox.capability_hash
    );

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL AND changes() <> NEW.released_delivery_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  UPDATE envelope
  SET status = (CASE
        WHEN NEW.completed_audit_event_id IS NOT NULL THEN 'completed'
        WHEN status = 'sent' THEN 'in_progress'
        ELSE status
      END),
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.envelope_id
    AND status IN ('sent', 'in_progress')
    AND sent_commit_sha = NEW.sent_commit_sha
    AND sent_commit_sha = repository_head
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
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.signed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at, 2
  );

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  )
  SELECT NEW.completed_audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence + 1, 'envelope.completed', NEW.actor_type, NEW.actor_id,
    NEW.completed_audit_payload_json, NEW.audit_event_hash, NEW.completed_audit_event_hash,
    NEW.updated_at, 2
  WHERE NEW.completed_audit_event_id IS NOT NULL;

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND (
      SELECT COUNT(*) FROM audit_event
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND id = NEW.completed_audit_event_id
        AND sequence = NEW.audit_sequence + 1
        AND event_type = 'envelope.completed'
        AND previous_hash = NEW.audit_event_hash
        AND event_hash = NEW.completed_audit_event_hash
    ) <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);
END;

ALTER TABLE envelope_send_command ADD COLUMN document_set_hash TEXT NULL;
ALTER TABLE envelope_send_command ADD COLUMN document_count INTEGER NULL;
ALTER TABLE envelope_send_command ADD COLUMN sent_documents_json TEXT NULL;

-- Drop before recreate: the 0043 guard still requires sent_pdf_object_key.
DROP TRIGGER IF EXISTS envelope_send_publish_guard;

CREATE TRIGGER envelope_send_publish_guard
AFTER INSERT ON envelope_send_publish
BEGIN
  -- The send command carries either the pinned document-set hash/count (new
  -- Worker) or the pinned legacy sent_pdf_* pointer (still-serving old
  -- Worker mid-rollout) -- never a partial or mixed combination of the two.
  -- Requiring one complete shape, and for the document-set shape that the
  -- pre-inserted per-document rows match the pinned count, is what keeps
  -- "sent" and "there is an exact rendering of each document that was sent"
  -- the same fact regardless of which Worker version handled the send.
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
              WHERE docs.organization_id = command.organization_id
                AND docs.envelope_id = command.envelope_id
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
      WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
        AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
    ) THEN RAISE(ABORT, 'envelope send document set missing') END);

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
        AND target.role IN ('signer', 'approver', 'viewer')) = (SELECT delivery_count FROM envelope_send_command command
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
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) SELECT command.audit_event_id, command.organization_id, command.envelope_id,
      command.audit_sequence, 'envelope.sent', command.actor_type, command.actor_id,
      command.audit_payload_json, command.previous_audit_hash, command.audit_event_hash,
      command.updated_at, 2
    FROM envelope_send_command command
    WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key;

  -- Published in the same trigger body, and therefore the same D1 batch, as
  -- the status flip and the audit event: a stale generation, a lost CAS, an
  -- audit conflict, or an idempotency conflict aborts all three together, so
  -- a mismatched document set is not reachable. The per-document rows are
  -- pre-inserted; this marker is what makes them readable. Skipped for a
  -- legacy send (document_set_hash IS NULL): envelope_sent_document_set's
  -- columns are NOT NULL, and a legacy send's evidence lives in
  -- envelope_sent_pdf / envelope_send_command.sent_pdf_* instead.
  INSERT INTO envelope_sent_document_set (
    organization_id, envelope_id, commit_sha, document_set_hash, document_count, created_at
  ) SELECT command.organization_id, command.envelope_id, command.commit_sha,
      command.document_set_hash, command.document_count, command.updated_at
    FROM envelope_send_command command
    WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
      AND command.document_set_hash IS NOT NULL;

  -- Mirrors the insert 0043 made unconditionally: the still-serving
  -- pre-migration Worker only ever pins the legacy sent_pdf_* shape, and
  -- envelope_sent_pdf was that shape's only publisher. Without this insert a
  -- legacy send flips the envelope to sent with no rendering pointer at all.
  -- Gated on sent_pdf_object_key IS NOT NULL so a new-shape (document-set)
  -- send, whose sent_pdf_* columns are all NULL, does not insert a row that
  -- would fail envelope_sent_pdf's NOT NULL columns.
  INSERT INTO envelope_sent_pdf (
    organization_id, envelope_id, commit_sha, object_key, sha256, byte_size,
    page_count, page_width, page_height, document_pages_json, created_at
  ) SELECT command.organization_id, command.envelope_id, command.commit_sha,
      command.sent_pdf_object_key, command.sent_pdf_sha256, command.sent_pdf_bytes,
      command.sent_pdf_page_count, command.sent_pdf_page_width, command.sent_pdf_page_height,
      command.sent_pdf_document_pages_json, command.updated_at
    FROM envelope_send_command command
    WHERE command.organization_id = NEW.organization_id AND command.actor_type = NEW.actor_type
      AND command.actor_id = NEW.actor_id AND command.idempotency_key = NEW.idempotency_key
      AND command.sent_pdf_object_key IS NOT NULL;
END;
