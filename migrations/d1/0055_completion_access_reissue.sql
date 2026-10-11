-- Completion access reissue: an append-only successor chain on the existing
-- completion delivery outbox. A reissue never mutates the predecessor row --
-- its original status, attempts, error, revocation, and expiry stay exactly
-- as the exhausting failure wrote them -- it only appends a new generation
-- chained to it by `predecessor_delivery_id`. The read side (current
-- generation) is therefore "no successor yet, or the newest one".
--
-- SQLite cannot drop or alter the inline `UNIQUE (envelope_id, recipient_id)`
-- table constraint, so the table is rebuilt (see 0036_capability_reissue.sql
-- for the same technique). D1 applies each migration inside a transaction,
-- and PRAGMA foreign_keys cannot change inside one, so every FK is deferred
-- to COMMIT instead of being toggled off.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE completion_delivery_outbox_new (
  id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  token_hash TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  access_revoked_at TEXT,
  sealed_token TEXT,
  sealing_key_id TEXT NOT NULL,
  sealed_token_sha256 TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TEXT,
  claim_token TEXT CHECK (
    claim_token IS NULL OR length(claim_token) BETWEEN 16 AND 200
  ),
  delivered_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  predecessor_delivery_id TEXT,
  failure_cause_code TEXT,
  PRIMARY KEY (id),
  UNIQUE (envelope_id, recipient_id, generation),
  UNIQUE (predecessor_delivery_id),
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact(envelope_id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id),
  FOREIGN KEY (predecessor_delivery_id) REFERENCES completion_delivery_outbox_new(id),
  CONSTRAINT completion_delivery_id_uuidv7 CHECK (
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
  CONSTRAINT completion_delivery_generation_predecessor CHECK (
    (generation = 0 AND predecessor_delivery_id IS NULL) OR
    (generation > 0 AND predecessor_delivery_id IS NOT NULL)
  ),
  -- Bounds every newly stored `failure_cause_code` to the exact shape the
  -- application layer already requires of it
  -- (`sanitizeCompletionDeliveryErrorCode` / `COMPLETION_DELIVERY_ERROR_CODE_PATTERN`
  -- in completion-delivery-store.ts), including the same sensitive-token-prefix
  -- exclusion -- never a fixed enum, since mail-provider-sourced codes are
  -- legitimately open-ended. A row written before this column existed is
  -- NULL and stays exempt: this bounds newly stored values only, never
  -- reinterprets history.
  CONSTRAINT completion_delivery_failure_cause_code_check CHECK (
    failure_cause_code IS NULL OR (
      length(failure_cause_code) BETWEEN 2 AND 65
      AND substr(failure_cause_code, 1, 1) GLOB '[a-z]'
      AND failure_cause_code NOT GLOB '*[^a-z0-9_]*'
      AND failure_cause_code NOT GLOB 'skca1_*'
      AND failure_cause_code NOT GLOB 'skcd1_*'
      AND failure_cause_code NOT GLOB 'skr1_*'
      AND failure_cause_code NOT GLOB 'skdc1_*'
      AND failure_cause_code NOT GLOB 'ski1_*'
      AND failure_cause_code NOT GLOB 'skiod1_*'
    )
  )
);

INSERT INTO completion_delivery_outbox_new (
  id, envelope_id, recipient_id, status, token_hash, access_expires_at,
  access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
  available_at, attempts, locked_at, claim_token, delivered_at,
  provider_message_id, last_error, retryable, created_at, updated_at,
  generation, predecessor_delivery_id, failure_cause_code
)
SELECT
  id, envelope_id, recipient_id, status, token_hash, access_expires_at,
  access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
  available_at, attempts, locked_at, claim_token, delivered_at,
  provider_message_id, last_error, retryable, created_at, updated_at,
  0, NULL, NULL
FROM completion_delivery_outbox;

DROP TABLE completion_delivery_outbox;
ALTER TABLE completion_delivery_outbox_new RENAME TO completion_delivery_outbox;

CREATE UNIQUE INDEX completion_delivery_outbox_token_hash
  ON completion_delivery_outbox(token_hash);

CREATE INDEX completion_delivery_outbox_claim
  ON completion_delivery_outbox(status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX completion_delivery_outbox_reclaim
  ON completion_delivery_outbox(locked_at, created_at)
  WHERE status = 'processing';

CREATE INDEX completion_delivery_outbox_terminal_cleanup
  ON completion_delivery_outbox(status, updated_at, created_at)
  WHERE retryable = 1 AND sealed_token IS NOT NULL;

CREATE INDEX completion_delivery_outbox_current_generation
  ON completion_delivery_outbox(envelope_id, recipient_id, generation DESC);

CREATE TRIGGER completion_delivery_outbox_claim_insert_guard
BEFORE INSERT ON completion_delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery claim state');
END;

CREATE TRIGGER completion_delivery_outbox_claim_state_guard
BEFORE UPDATE OF status, claim_token, locked_at ON completion_delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery claim state');
END;

CREATE TRIGGER completion_delivery_outbox_terminal_insert_guard
BEFORE INSERT ON completion_delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND (NEW.retryable <> 1 OR NEW.access_revoked_at IS NOT NULL)
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_token IS NOT NULL)
) OR (
  NEW.status = 'failed'
  AND (
    (NEW.retryable = 1 AND NEW.access_revoked_at IS NOT NULL) OR
    (NEW.retryable = 0 AND (NEW.sealed_token IS NOT NULL OR NEW.access_revoked_at IS NULL))
  )
) OR (
  NEW.retryable = 0
  AND NEW.status NOT IN ('failed', 'delivered')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery terminal state');
END;

CREATE TRIGGER completion_delivery_outbox_terminal_state_guard
BEFORE UPDATE OF status, sealed_token, retryable, access_revoked_at ON completion_delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND (NEW.retryable <> 1 OR NEW.access_revoked_at IS NOT NULL)
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_token IS NOT NULL)
) OR (
  NEW.status = 'failed'
  AND (
    (NEW.retryable = 1 AND NEW.access_revoked_at IS NOT NULL) OR
    (NEW.retryable = 0 AND (NEW.sealed_token IS NOT NULL OR NEW.access_revoked_at IS NULL))
  )
) OR (
  NEW.retryable = 0
  AND NEW.status NOT IN ('failed', 'delivered')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery terminal state');
END;

CREATE TRIGGER completion_delivery_outbox_recipient_scope_insert_guard
BEFORE INSERT ON completion_delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
    AND target.role IN ('signer', 'approver', 'viewer', 'cc')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery recipient scope');
END;

CREATE TRIGGER completion_delivery_outbox_recipient_scope_update_guard
BEFORE UPDATE OF envelope_id, recipient_id ON completion_delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
    AND target.role IN ('signer', 'approver', 'viewer', 'cc')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery recipient scope');
END;

-- Operator reissue receipts. The CAS tuple (`expected_attempts`,
-- `expected_failed_at`, `expected_error_code`) is the exact exhaustion
-- generation the caller observed in the read side: it keeps a stale or
-- duplicate command from reissuing a predecessor a concurrent reissue (or a
-- fresh retryable failure cycle) has already moved past.
--
-- `sealed_token` is write-only input to the trigger below: it is copied into
-- the new `completion_delivery_outbox` row and then scrubbed from this
-- receipt in the same transaction, so the ciphertext is never retained twice.
CREATE TABLE completion_access_reissue_command (
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  predecessor_delivery_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_attempts INTEGER NOT NULL CHECK (expected_attempts >= 0),
  expected_failed_at TEXT NOT NULL,
  expected_error_code TEXT NOT NULL,
  -- The completion manifest and PDF digests the caller verified against
  -- object storage, outside this transaction, immediately before this row
  -- was inserted. The AFTER INSERT trigger rechecks these against the
  -- current `completion_artifact` / `completion_artifact_pdf` rows -- never
  -- against object storage again -- so a repair that replaces the artifact
  -- mid-flight is caught without doing object-storage IO under the lock.
  expected_json_sha256 TEXT NOT NULL,
  expected_markdown_sha256 TEXT NOT NULL,
  expected_pdf_sha256 TEXT NOT NULL,
  new_delivery_id TEXT NOT NULL,
  new_token_hash TEXT NOT NULL,
  new_access_expires_at TEXT NOT NULL,
  sealed_token TEXT,
  sealing_key_id TEXT NOT NULL,
  sealed_token_sha256 TEXT NOT NULL,
  reissued_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (audit_event_id),
  UNIQUE (new_delivery_id),
  UNIQUE (predecessor_delivery_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id),
  FOREIGN KEY (predecessor_delivery_id) REFERENCES completion_delivery_outbox(id),
  FOREIGN KEY (new_delivery_id) REFERENCES completion_delivery_outbox(id)
);

CREATE INDEX completion_access_reissue_command_recipient
  ON completion_access_reissue_command(envelope_id, recipient_id, reissued_at DESC);

CREATE TRIGGER completion_access_reissue_command_publish
AFTER INSERT ON completion_access_reissue_command
BEGIN
  -- Predicate 1: envelope must still be completed.
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope WHERE id = NEW.envelope_id AND status = 'completed'
    )
    THEN RAISE(ABORT, 'completion access reissue envelope not eligible')
  END);

  -- Predicate 2: recipient must still be an eligible completion-delivery role.
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE envelope_id = NEW.envelope_id
        AND id = NEW.recipient_id
        AND role IN ('signer', 'approver', 'viewer', 'cc')
    )
    THEN RAISE(ABORT, 'completion access reissue recipient not eligible')
  END);

  -- Predicate 3: the predecessor must be the exact exhausted generation the
  -- caller observed -- current (no successor yet), failed, nonretryable,
  -- already revoked, already scrubbed, no lease, and matching the CAS tuple.
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_delivery_outbox predecessor
      WHERE predecessor.id = NEW.predecessor_delivery_id
        AND predecessor.envelope_id = NEW.envelope_id
        AND predecessor.recipient_id = NEW.recipient_id
        AND predecessor.status = 'failed'
        AND predecessor.retryable = 0
        AND predecessor.access_revoked_at IS NOT NULL
        AND predecessor.sealed_token IS NULL
        AND predecessor.claim_token IS NULL
        AND predecessor.locked_at IS NULL
        AND predecessor.attempts = NEW.expected_attempts
        AND predecessor.updated_at = NEW.expected_failed_at
        AND predecessor.last_error = NEW.expected_error_code
        AND NOT EXISTS (
          SELECT 1 FROM completion_delivery_outbox successor
          WHERE successor.predecessor_delivery_id = predecessor.id
        )
    )
    THEN RAISE(ABORT, 'completion access reissue stale generation')
  END);

  -- Predicate 4: audit head sequence and previous hash.
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM audit_event
      WHERE envelope_id = NEW.envelope_id
        AND sequence = NEW.audit_sequence - 1
        AND event_hash = NEW.previous_audit_hash
    )
    THEN RAISE(ABORT, 'completion access reissue audit head conflict')
  END);

  -- Predicate 5: the completion manifest and PDF the caller verified against
  -- object storage must still be the published artifact -- a concurrent
  -- repair that replaced either pointer invalidates this command rather than
  -- granting access to evidence the caller never actually checked.
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_artifact
      WHERE envelope_id = NEW.envelope_id
        AND json_sha256 = NEW.expected_json_sha256
        AND markdown_sha256 = NEW.expected_markdown_sha256
    ) OR NOT EXISTS (
      SELECT 1 FROM completion_artifact_pdf
      WHERE envelope_id = NEW.envelope_id
        AND pdf_sha256 = NEW.expected_pdf_sha256
    )
    THEN RAISE(ABORT, 'completion access reissue artifact changed')
  END);

  -- Actions:
  -- 1. Insert the new successor generation.
  INSERT INTO completion_delivery_outbox (
    id, envelope_id, recipient_id, status, token_hash, access_expires_at,
    access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
    available_at, attempts, locked_at, claim_token, delivered_at,
    provider_message_id, last_error, retryable, created_at, updated_at,
    generation, predecessor_delivery_id, failure_cause_code
  )
  SELECT
    NEW.new_delivery_id, NEW.envelope_id, NEW.recipient_id, 'pending',
    NEW.new_token_hash, NEW.new_access_expires_at, NULL, NEW.sealed_token,
    NEW.sealing_key_id, NEW.sealed_token_sha256, NEW.reissued_at, 0, NULL,
    NULL, NULL, NULL, NULL, 1, NEW.reissued_at, NEW.reissued_at,
    predecessor.generation + 1, NEW.predecessor_delivery_id, NULL
  FROM completion_delivery_outbox predecessor
  WHERE predecessor.id = NEW.predecessor_delivery_id;

  -- 2. Scrub the ciphertext from this receipt: the outbox row above is now
  -- the only place it lives.
  UPDATE completion_access_reissue_command
  SET sealed_token = NULL
  WHERE actor_type = NEW.actor_type
    AND actor_id = NEW.actor_id
    AND idempotency_key = NEW.idempotency_key;

  -- 3. Insert audit event.
  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id, NEW.audit_sequence,
    'recipient.completion_access_reissued', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.reissued_at, 3
  );

  -- 4. Update envelope updated_at.
  UPDATE envelope
  SET updated_at = NEW.reissued_at
  WHERE id = NEW.envelope_id;
END;
