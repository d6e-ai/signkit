-- API-key voids record actor_type = 'agent'. The original CHECK
-- (actor_type = 'user') rejected those rows, so audit hash v2 could not
-- truthfully stamp envelope.voided. SQLite cannot ALTER a CHECK, so the
-- table is rebuilt. DROP TABLE also drops envelope_void_command_publish;
-- recreate it with the same hash_version = 3 semantics as 0023.
--
-- No inbound FKs reference envelope_void_command, but D1 still applies this
-- file inside a transaction. Defer FK checks until COMMIT so DROP/rename is
-- safe the same way 0036 is (PRAGMA foreign_keys is a no-op in a transaction).

PRAGMA defer_foreign_keys = ON;

CREATE TABLE envelope_void_command_next (
  envelope_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  previous_status TEXT NOT NULL CHECK (previous_status IN ('draft','ready','sent','in_progress')),
  expected_generation INTEGER NOT NULL CHECK (expected_generation BETWEEN 0 AND 2147483647),
  repository_head TEXT,
  sent_commit_sha TEXT,
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  revocation_evidence_version INTEGER NOT NULL CHECK (revocation_evidence_version = 1),
  revoked_recipient_ids_json TEXT NOT NULL
    CHECK (json_valid(revoked_recipient_ids_json) AND json_type(revoked_recipient_ids_json) = 'array'),
  revoked_recipient_count INTEGER NOT NULL CHECK (revoked_recipient_count >= 0),
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (envelope_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id)
);

INSERT INTO envelope_void_command_next (
  envelope_id, actor_type, actor_id, idempotency_key, request_hash,
  previous_status, expected_generation, repository_head, sent_commit_sha, updated_at,
  audit_event_id, audit_sequence, previous_audit_hash, audit_event_hash, audit_payload_json,
  revocation_evidence_version, revoked_recipient_ids_json, revoked_recipient_count
)
SELECT
  envelope_id, actor_type, actor_id, idempotency_key, request_hash,
  previous_status, expected_generation, repository_head, sent_commit_sha, updated_at,
  audit_event_id, audit_sequence, previous_audit_hash, audit_event_hash, audit_payload_json,
  revocation_evidence_version, revoked_recipient_ids_json, revoked_recipient_count
FROM envelope_void_command;

DROP TABLE envelope_void_command;

ALTER TABLE envelope_void_command_next RENAME TO envelope_void_command;

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
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.voided', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at,
    3);
END;
