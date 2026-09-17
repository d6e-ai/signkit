-- Recipient capability reissue, append-only outbox, and issuance ledger.
-- Allows reissuing delivery for released pending or viewed recipients,
-- creating an append-only capability lineage without mutating first-view evidence.
-- Recreated command triggers must stamp audit_event.hash_version = 3 explicitly:
-- SQLite cannot ALTER COLUMN SET DEFAULT (see 0023_audit_hash_v2.sql).
--
-- D1 applies each migration inside a transaction. PRAGMA foreign_keys cannot
-- change inside a transaction (SQLite treats it as a no-op), so toggling it
-- here would not disable checks. Defer every FK until COMMIT instead.

PRAGMA defer_foreign_keys = ON;

-- Drop dependent triggers that reference delivery_outbox before rebuild.
DROP TRIGGER IF EXISTS envelope_expiry_command_publish;
DROP TRIGGER IF EXISTS envelope_send_publish_guard;
DROP TRIGGER IF EXISTS envelope_void_command_publish;
DROP TRIGGER IF EXISTS recipient_approved_command_publish;
DROP TRIGGER IF EXISTS recipient_approved_completion_guard;
DROP TRIGGER IF EXISTS recipient_declined_command_publish;
DROP TRIGGER IF EXISTS recipient_signed_command_publish;
DROP TRIGGER IF EXISTS recipient_signed_completion_guard;

CREATE TABLE delivery_outbox_new (
  id TEXT NOT NULL,
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
  claim_token TEXT CHECK (
    claim_token IS NULL OR length(claim_token) BETWEEN 16 AND 200
  ),
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  PRIMARY KEY (id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id),
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

INSERT INTO delivery_outbox_new (
  id, envelope_id, recipient_id, kind, status, capability_hash,
  reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
  available_at, attempts, locked_at, delivered_at, provider_message_id, last_error,
  created_at, updated_at, claim_token, retryable
)
SELECT
  id, envelope_id, recipient_id, kind, status, capability_hash,
  reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
  available_at, attempts, locked_at, delivered_at, provider_message_id, last_error,
  created_at, updated_at, claim_token, retryable
FROM delivery_outbox;

DROP TABLE delivery_outbox;
ALTER TABLE delivery_outbox_new RENAME TO delivery_outbox;

CREATE INDEX delivery_outbox_claim
  ON delivery_outbox(status, available_at, created_at)
  WHERE status IN ('pending','failed');

CREATE INDEX delivery_outbox_reclaim
  ON delivery_outbox(locked_at, created_at)
  WHERE status = 'processing';

CREATE INDEX delivery_outbox_terminal_cleanup
  ON delivery_outbox(status, updated_at, created_at)
  WHERE retryable = 1 AND sealed_capability IS NOT NULL;

CREATE INDEX delivery_outbox_recipient
  ON delivery_outbox(envelope_id, recipient_id, kind, created_at);

CREATE TRIGGER delivery_outbox_claim_insert_guard
BEFORE INSERT ON delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery claim state');
END;

CREATE TRIGGER delivery_outbox_claim_state_guard
BEFORE UPDATE OF status, claim_token, locked_at ON delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery claim state');
END;

CREATE TRIGGER delivery_outbox_terminal_insert_guard
BEFORE INSERT ON delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND NEW.retryable <> 1
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_capability IS NOT NULL)
) OR (
  NEW.retryable = 0
  AND (NEW.status NOT IN ('failed', 'delivered') OR NEW.sealed_capability IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery terminal state');
END;

CREATE TRIGGER delivery_outbox_terminal_state_guard
BEFORE UPDATE OF status, sealed_capability, retryable ON delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND NEW.retryable <> 1
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_capability IS NOT NULL)
) OR (
  NEW.retryable = 0
  AND (NEW.status NOT IN ('failed', 'delivered') OR NEW.sealed_capability IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery terminal state');
END;

CREATE TRIGGER delivery_outbox_recipient_scope_insert_guard
BEFORE INSERT ON delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery recipient scope');
END;

CREATE TRIGGER delivery_outbox_recipient_scope_update_guard
BEFORE UPDATE OF envelope_id, recipient_id ON delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery recipient scope');
END;

CREATE TABLE recipient_capability_issuance (
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  predecessor_capability_hash TEXT,
  issued_at TEXT NOT NULL,
  superseded_at TEXT,
  PRIMARY KEY (capability_hash),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id)
);

CREATE INDEX recipient_capability_issuance_recipient
  ON recipient_capability_issuance(recipient_id, issued_at DESC);

-- Backfill trivial single-entry lineage for every existing recipient capability
INSERT OR IGNORE INTO recipient_capability_issuance (
  envelope_id, recipient_id, capability_hash, predecessor_capability_hash, issued_at
)
SELECT envelope_id, id, capability_hash, NULL, created_at
FROM recipient
WHERE capability_hash IS NOT NULL;

CREATE TABLE recipient_capability_reissue_command (
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  previous_capability_hash TEXT NOT NULL,
  new_capability_hash TEXT NOT NULL,
  reserved_capability_expires_at TEXT NOT NULL,
  sealed_capability TEXT NOT NULL,
  sealing_key_id TEXT NOT NULL,
  sealed_capability_sha256 TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (audit_event_id),
  UNIQUE (new_capability_hash),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id)
);

CREATE TRIGGER recipient_capability_reissue_command_publish
AFTER INSERT ON recipient_capability_reissue_command
BEGIN
  -- Predicate 1: Envelope must be sent or in_progress
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope
      WHERE id = NEW.envelope_id
        AND status IN ('sent', 'in_progress')
    )
    THEN RAISE(ABORT, 'reissue envelope not eligible')
  END);

  -- Predicate 2: Recipient must be pending or viewed, already released (capability_expires_at IS NOT NULL),
  -- and matching previous_capability_hash
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND id = NEW.recipient_id
        AND status IN ('pending', 'viewed')
        AND capability_expires_at IS NOT NULL
        AND capability_hash = NEW.previous_capability_hash
        AND capability_revoked_at IS NULL
    )
    THEN RAISE(ABORT, 'reissue recipient not eligible')
  END);

  -- Predicate 3: No in-flight delivery lease on current outbox row, and current outbox is not blocked
  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND recipient_id = NEW.recipient_id
        AND status = 'processing'
    )
    THEN RAISE(ABORT, 'reissue delivery in flight')
  END);

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND recipient_id = NEW.recipient_id
        AND status = 'blocked'
    )
    THEN RAISE(ABORT, 'reissue delivery blocked')
  END);

  -- Predicate 4: Audit head sequence and previous hash
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM audit_event
      WHERE envelope_id = NEW.envelope_id
        AND sequence = NEW.audit_sequence - 1
        AND event_hash = NEW.previous_audit_hash
    )
    THEN RAISE(ABORT, 'reissue audit head conflict')
  END);

  -- Actions:
  -- 1. Supersede predecessor in issuance ledger
  UPDATE recipient_capability_issuance
  SET superseded_at = NEW.updated_at
  WHERE recipient_id = NEW.recipient_id
    AND capability_hash = NEW.previous_capability_hash;

  -- 2. Insert new capability in issuance ledger
  INSERT INTO recipient_capability_issuance (
    envelope_id, recipient_id, capability_hash, predecessor_capability_hash, issued_at
  ) VALUES (
    NEW.envelope_id, NEW.recipient_id, NEW.new_capability_hash, NEW.previous_capability_hash, NEW.updated_at
  );

  -- 3. Update recipient capability
  UPDATE recipient
  SET capability_hash = NEW.new_capability_hash,
      capability_expires_at = NEW.reserved_capability_expires_at,
      capability_revoked_at = NULL,
      updated_at = NEW.updated_at
  WHERE id = NEW.recipient_id;

  -- 4. Mark old pending/failed delivery outbox row failed/superseded
  UPDATE delivery_outbox
  SET status = 'failed',
      claim_token = NULL,
      locked_at = NULL,
      retryable = 0,
      sealed_capability = NULL,
      last_error = 'capability_superseded',
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND recipient_id = NEW.recipient_id
    AND (status = 'pending' OR (status = 'failed' AND retryable = 1));

  -- 5. Insert new outbox row
  INSERT INTO delivery_outbox (
    id, envelope_id, recipient_id, kind, status,
    capability_hash, reserved_capability_expires_at, sealed_capability,
    sealing_key_id, sealed_capability_sha256, available_at, attempts,
    created_at, updated_at, retryable
  ) VALUES (
    NEW.outbox_id, NEW.envelope_id, NEW.recipient_id,
    'recipient_invitation', 'pending', NEW.new_capability_hash,
    NEW.reserved_capability_expires_at, NEW.sealed_capability,
    NEW.sealing_key_id, NEW.sealed_capability_sha256, NEW.updated_at, 0,
    NEW.updated_at, NEW.updated_at, 1
  );

  -- 6. Insert audit event
  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id, NEW.audit_sequence,
    'recipient.capability_reissued', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at, 3
  );

  -- 7. Update envelope updated_at
  UPDATE envelope
  SET updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id;
END;

-- Recreate dependent triggers against the rebuilt delivery_outbox table.
-- Restored from 0034_envelope_expiry.sql
CREATE TRIGGER envelope_expiry_command_publish
AFTER INSERT ON envelope_expiry_command
BEGIN
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status IN ('pending', 'viewed')
        AND capability_expires_at IS NOT NULL
        AND julianday(capability_expires_at) <= julianday(NEW.updated_at)
    )
    OR EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status IN ('pending', 'viewed')
        AND capability_expires_at IS NOT NULL
        AND julianday(capability_expires_at) > julianday(NEW.updated_at)
    )
    THEN RAISE(ABORT, 'envelope expiry eligibility conflict')
  END);

  SELECT (CASE
    WHEN NEW.revoked_recipient_count <> json_array_length(NEW.revoked_recipient_ids_json)
      OR NEW.revoked_recipient_ids_json <> (
        SELECT json_group_array(id)
        FROM (
          SELECT id
          FROM recipient
          WHERE envelope_id = NEW.envelope_id
            AND status <> 'completed'
            AND capability_hash IS NOT NULL
            AND capability_revoked_at IS NULL
          ORDER BY id
        ) revocable
      )
    THEN RAISE(ABORT, 'envelope expiry revocation evidence conflict')
  END);

  SELECT (CASE
    WHEN json_valid(NEW.audit_payload_json) <> 1
      OR json_extract(NEW.audit_payload_json, '$.previousStatus') IS NOT NEW.previous_status
      OR json_extract(NEW.audit_payload_json, '$.generation') IS NOT NEW.expected_generation
      OR json_extract(NEW.audit_payload_json, '$.repositoryHead') IS NOT NEW.repository_head
      OR json_extract(NEW.audit_payload_json, '$.sentCommitSha') IS NOT NEW.sent_commit_sha
      OR json_extract(NEW.audit_payload_json, '$.expiredAt') IS NOT NEW.updated_at
      OR json_extract(NEW.audit_payload_json, '$.revokedCapabilities.reason') IS NOT 'envelope_expired'
      OR json_extract(NEW.audit_payload_json, '$.revokedCapabilities.recipientIds')
        IS NOT NEW.revoked_recipient_ids_json
    THEN RAISE(ABORT, 'envelope expiry audit payload conflict')
  END);

  UPDATE delivery_outbox
  SET status = 'failed',
      claim_token = NULL,
      locked_at = NULL,
      retryable = 0,
      sealed_capability = NULL,
      available_at = COALESCE(available_at, NEW.updated_at),
      last_error = 'envelope_terminal',
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND (
      status IN ('blocked', 'pending')
      OR (status = 'failed' AND retryable = 1)
    );

  UPDATE recipient
  SET capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;

  SELECT (CASE
    WHEN changes() <> NEW.revoked_recipient_count
    THEN RAISE(ABORT, 'envelope expiry revocation evidence conflict')
  END);

  UPDATE envelope
  SET status = 'expired',
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status = NEW.previous_status
    AND status IN ('sent','in_progress')
    AND repository_generation = NEW.expected_generation
    AND repository_head IS NEW.repository_head
    AND sent_commit_sha IS NEW.sent_commit_sha
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
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope expiry publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.expired', 'system',
    'envelope-expiry-drain', NEW.audit_payload_json, NEW.previous_audit_hash,
    NEW.audit_event_hash, NEW.updated_at, 3
  );
END;

-- Restored from 0015_observer_routing_semantics.sql
CREATE TRIGGER envelope_send_publish_guard
AFTER INSERT ON envelope_send_publish
BEGIN
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
        AND previous.id = command.ready_audit_event_id
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
END;

-- Restored from 0014_envelope_voided.sql
CREATE TRIGGER envelope_void_command_publish
AFTER INSERT ON envelope_void_command
BEGIN
  SELECT (CASE
    WHEN NEW.revocation_evidence_version <> 1
      OR NEW.revoked_recipient_count <> json_array_length(NEW.revoked_recipient_ids_json)
      OR NEW.revoked_recipient_ids_json <> (
        SELECT json_group_array(id)
        FROM (
          SELECT id
          FROM recipient
          WHERE envelope_id = NEW.envelope_id
            AND status <> 'completed'
            AND capability_hash IS NOT NULL
            AND capability_revoked_at IS NULL
          ORDER BY id
        ) revocable
      )
    THEN RAISE(ABORT, 'envelope void revocation evidence conflict')
  END);

  SELECT (CASE
    WHEN json_valid(NEW.audit_payload_json) <> 1
      OR json_extract(NEW.audit_payload_json, '$.previousStatus') IS NOT NEW.previous_status
      OR json_extract(NEW.audit_payload_json, '$.generation') IS NOT NEW.expected_generation
      OR json_extract(NEW.audit_payload_json, '$.repositoryHead') IS NOT NEW.repository_head
      OR json_extract(NEW.audit_payload_json, '$.sentCommitSha') IS NOT NEW.sent_commit_sha
      OR json_extract(NEW.audit_payload_json, '$.voidedAt') IS NOT NEW.updated_at
      OR json_extract(NEW.audit_payload_json, '$.revokedCapabilities.reason') IS NOT 'envelope_voided'
      OR json_extract(NEW.audit_payload_json, '$.revokedCapabilities.recipientIds')
        IS NOT NEW.revoked_recipient_ids_json
    THEN RAISE(ABORT, 'envelope void audit payload conflict')
  END);

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1
      FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND status = 'processing'
    )
    THEN RAISE(ABORT, 'envelope void delivery in flight')
  END);

  UPDATE delivery_outbox
  SET status = 'failed',
      claim_token = NULL,
      locked_at = NULL,
      retryable = 0,
      sealed_capability = NULL,
      available_at = COALESCE(available_at, NEW.updated_at),
      last_error = 'envelope_terminal',
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND (
      status IN ('blocked', 'pending')
      OR (status = 'failed' AND retryable = 1)
    );

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1
      FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND (
          status IN ('blocked', 'pending', 'processing')
          OR (status = 'failed' AND retryable = 1)
          OR sealed_capability IS NOT NULL
        )
    )
    THEN RAISE(ABORT, 'envelope void delivery cleanup conflict')
  END);

  UPDATE recipient
  SET capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;

  SELECT (CASE
    WHEN changes() <> NEW.revoked_recipient_count
    THEN RAISE(ABORT, 'envelope void revocation evidence conflict')
  END);

  UPDATE envelope
  SET status = 'voided',
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status = NEW.previous_status
    AND status IN ('draft','ready','sent','in_progress')
    AND repository_generation = NEW.expected_generation
    AND repository_head IS NEW.repository_head
    AND sent_commit_sha IS NEW.sent_commit_sha
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
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope void publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.voided', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at, 3
  );
END;

-- Restored from 0015_observer_routing_semantics.sql
CREATE TRIGGER recipient_approved_command_publish
AFTER INSERT ON recipient_approved_command
BEGIN
  UPDATE recipient
  SET status = 'completed',
      capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE id = NEW.recipient_id
    AND envelope_id = NEW.envelope_id
    AND status = 'viewed'
    AND role = 'approver'
    AND role = NEW.recipient_role
    AND routing_order = NEW.routing_order
    AND capability_hash = NEW.capability_hash
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NOT NULL
    AND julianday(capability_expires_at) > julianday(NEW.updated_at);

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       julianday(NEW.next_capability_expires_at) <= julianday(NEW.updated_at)
       OR julianday(NEW.next_capability_expires_at) > julianday(NEW.updated_at, '+15 days')
     )
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NULL
     AND NEW.completed_audit_event_id IS NULL
     AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       SELECT MIN(routing_order) FROM recipient
       WHERE envelope_id = NEW.envelope_id
         AND role IN ('signer', 'approver')
         AND status <> 'completed'
         AND routing_order > NEW.routing_order
     ) IS NOT NEW.next_routing_order
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  UPDATE recipient
  SET capability_expires_at = NEW.next_capability_expires_at,
      updated_at = NEW.updated_at
  WHERE NEW.next_routing_order IS NOT NULL
    AND envelope_id = NEW.envelope_id
    AND routing_order = NEW.next_routing_order
    AND role IN ('signer', 'approver', 'viewer')
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NULL;

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL AND changes() <> NEW.released_delivery_count
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  UPDATE delivery_outbox
  SET status = 'pending',
      reserved_capability_expires_at = NEW.next_capability_expires_at,
      available_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE NEW.next_routing_order IS NOT NULL
    AND envelope_id = NEW.envelope_id
    AND status = 'blocked'
    AND available_at IS NULL
    AND sealed_capability IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM recipient target
      WHERE target.id = delivery_outbox.recipient_id
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
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  UPDATE envelope
  SET status = (CASE
        WHEN NEW.completed_audit_event_id IS NOT NULL THEN 'completed'
        WHEN status = 'sent' THEN 'in_progress'
        ELSE status
      END),
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status IN ('sent', 'in_progress')
    AND sent_commit_sha = NEW.sent_commit_sha
    AND sent_commit_sha = repository_head
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
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.approved', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at, 3
  );

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  )
  SELECT NEW.completed_audit_event_id, NEW.envelope_id,
    NEW.audit_sequence + 1, 'envelope.completed', NEW.actor_type, NEW.actor_id,
    NEW.completed_audit_payload_json, NEW.audit_event_hash, NEW.completed_audit_event_hash,
    NEW.updated_at, 3
  WHERE NEW.completed_audit_event_id IS NOT NULL;

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND (
      SELECT COUNT(*) FROM audit_event
      WHERE envelope_id = NEW.envelope_id
        AND id = NEW.completed_audit_event_id
        AND sequence = NEW.audit_sequence + 1
        AND event_type = 'envelope.completed'
        AND previous_hash = NEW.audit_event_hash
        AND event_hash = NEW.completed_audit_event_hash
    ) <> 1 THEN RAISE(ABORT, 'recipient approved publish conflict')
  END);
END;

-- Restored from 0015_observer_routing_semantics.sql
CREATE TRIGGER recipient_approved_completion_guard
BEFORE INSERT ON recipient_approved_command
WHEN NEW.completed_audit_event_id IS NOT NULL
BEGIN
  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND status = 'processing'
    ) THEN RAISE(ABORT, 'recipient approved delivery in flight')
  END);

  UPDATE delivery_outbox
  SET status = 'failed',
      claim_token = NULL,
      locked_at = NULL,
      retryable = 0,
      sealed_capability = NULL,
      available_at = COALESCE(available_at, NEW.updated_at),
      last_error = 'envelope_terminal',
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable = 1));

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND (status IN ('blocked', 'pending', 'processing')
          OR (status = 'failed' AND retryable = 1)
          OR sealed_capability IS NOT NULL)
    ) THEN RAISE(ABORT, 'recipient approved delivery cleanup conflict')
  END);

  UPDATE recipient
  SET capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND id <> NEW.recipient_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;
END;

-- Restored from 0013_terminal_delivery_cleanup.sql
CREATE TRIGGER recipient_declined_command_publish
AFTER INSERT ON recipient_declined_command
BEGIN
  SELECT (CASE
    WHEN NEW.revocation_evidence_version <> 2
      OR NEW.revoked_recipient_count <> json_array_length(NEW.revoked_recipient_ids_json)
      OR NEW.revoked_recipient_ids_json <> (
        SELECT json_group_array(id)
        FROM (
          SELECT id
          FROM recipient
          WHERE envelope_id = NEW.envelope_id
            AND id <> NEW.recipient_id
            AND status <> 'completed'
            AND capability_hash IS NOT NULL
            AND capability_revoked_at IS NULL
          ORDER BY id
        ) revocable
      )
    THEN RAISE(ABORT, 'recipient declined revocation evidence conflict')
  END);

  SELECT (CASE
    WHEN json_valid(NEW.audit_payload_json) <> 1
    THEN RAISE(ABORT, 'recipient declined audit payload conflict')
  END);

  SELECT (CASE
    WHEN json_extract(NEW.audit_payload_json, '$.revokedCapabilities.reason') IS NOT 'envelope_declined'
      OR json_extract(NEW.audit_payload_json, '$.revokedCapabilities.recipientIds')
        IS NOT NEW.revoked_recipient_ids_json
    THEN RAISE(ABORT, 'recipient declined audit payload conflict')
  END);

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1
      FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND status = 'processing'
    )
    THEN RAISE(ABORT, 'recipient declined delivery in flight')
  END);

  UPDATE delivery_outbox
  SET status = 'failed',
      claim_token = NULL,
      locked_at = NULL,
      retryable = 0,
      sealed_capability = NULL,
      available_at = COALESCE(available_at, NEW.updated_at),
      last_error = 'envelope_terminal',
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND (
      status IN ('blocked', 'pending')
      OR (status = 'failed' AND retryable = 1)
    );

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1
      FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND (
          status IN ('blocked', 'pending', 'processing')
          OR (status = 'failed' AND retryable = 1)
        )
    )
    THEN RAISE(ABORT, 'recipient declined delivery cleanup conflict')
  END);

  UPDATE recipient
  SET status = 'declined',
      capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE id = NEW.recipient_id
    AND envelope_id = NEW.envelope_id
    AND status IN ('pending', 'viewed')
    AND role = NEW.recipient_role
    AND role IN ('signer', 'approver')
    AND routing_order = NEW.routing_order
    AND capability_hash = NEW.capability_hash
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NOT NULL
    AND julianday(capability_expires_at) > julianday(NEW.updated_at);

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient declined publish conflict')
  END);

  UPDATE recipient
  SET capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND id <> NEW.recipient_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;

  SELECT (CASE
    WHEN changes() <> NEW.revoked_recipient_count
    THEN RAISE(ABORT, 'recipient declined revocation evidence conflict')
  END);

  UPDATE envelope
  SET status = 'declined',
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status IN ('sent', 'in_progress')
    AND sent_commit_sha = NEW.sent_commit_sha
    AND sent_commit_sha = repository_head
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
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient declined publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.declined', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at, 3
  );
END;

-- Restored from 0015_observer_routing_semantics.sql
CREATE TRIGGER recipient_signed_command_publish
AFTER INSERT ON recipient_signed_command
BEGIN
  UPDATE recipient
  SET status = 'completed',
      capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE id = NEW.recipient_id
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
      WHERE id = NEW.envelope_id
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
      WHERE envelope_id = NEW.envelope_id
        AND recipient_id = NEW.recipient_id
    ) <> NEW.field_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.field_values_json) declared
      WHERE NOT EXISTS (
        SELECT 1 FROM envelope_field field
        WHERE field.envelope_id = NEW.envelope_id
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
      WHERE envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
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
      WHERE envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       SELECT MIN(routing_order) FROM recipient
       WHERE envelope_id = NEW.envelope_id
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
    AND envelope_id = NEW.envelope_id
    AND status = 'blocked'
    AND available_at IS NULL
    AND sealed_capability IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM recipient target
      WHERE target.id = delivery_outbox.recipient_id
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
  WHERE id = NEW.envelope_id
    AND status IN ('sent', 'in_progress')
    AND sent_commit_sha = NEW.sent_commit_sha
    AND sent_commit_sha = repository_head
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
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.signed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at, 3
  );

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  )
  SELECT NEW.completed_audit_event_id, NEW.envelope_id,
    NEW.audit_sequence + 1, 'envelope.completed', NEW.actor_type, NEW.actor_id,
    NEW.completed_audit_payload_json, NEW.audit_event_hash, NEW.completed_audit_event_hash,
    NEW.updated_at, 3
  WHERE NEW.completed_audit_event_id IS NOT NULL;

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND (
      SELECT COUNT(*) FROM audit_event
      WHERE envelope_id = NEW.envelope_id
        AND id = NEW.completed_audit_event_id
        AND sequence = NEW.audit_sequence + 1
        AND event_type = 'envelope.completed'
        AND previous_hash = NEW.audit_event_hash
        AND event_hash = NEW.completed_audit_event_hash
    ) <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);
END;

-- Restored from 0015_observer_routing_semantics.sql
CREATE TRIGGER recipient_signed_completion_guard
BEFORE INSERT ON recipient_signed_command
WHEN NEW.completed_audit_event_id IS NOT NULL
BEGIN
  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND status = 'processing'
    ) THEN RAISE(ABORT, 'recipient signed delivery in flight')
  END);

  UPDATE delivery_outbox
  SET status = 'failed',
      claim_token = NULL,
      locked_at = NULL,
      retryable = 0,
      sealed_capability = NULL,
      available_at = COALESCE(available_at, NEW.updated_at),
      last_error = 'envelope_terminal',
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable = 1));

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE envelope_id = NEW.envelope_id
        AND (status IN ('blocked', 'pending', 'processing')
          OR (status = 'failed' AND retryable = 1)
          OR sealed_capability IS NOT NULL)
    ) THEN RAISE(ABORT, 'recipient signed delivery cleanup conflict')
  END);

  UPDATE recipient
  SET capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND id <> NEW.recipient_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;
END;
