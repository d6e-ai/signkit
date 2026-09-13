CREATE TABLE envelope_void_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
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
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, envelope_id),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);

-- The command insert is the sole D1 publication boundary. Any evidence,
-- delivery-cleanup, recipient-revocation, envelope-CAS, or audit failure rolls
-- back the command and every mutation performed by this trigger.
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
          WHERE organization_id = NEW.organization_id
            AND envelope_id = NEW.envelope_id
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
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
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
  WHERE organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
    AND (
      status IN ('blocked', 'pending')
      OR (status = 'failed' AND retryable = 1)
    );

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1
      FROM delivery_outbox
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
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
  WHERE organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
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
  WHERE organization_id = NEW.organization_id
    AND id = NEW.envelope_id
    AND status = NEW.previous_status
    AND status IN ('draft','ready','sent','in_progress')
    AND repository_generation = NEW.expected_generation
    AND repository_head IS NEW.repository_head
    AND sent_commit_sha IS NEW.sent_commit_sha
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope void publish conflict')
  END);

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.voided', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );
END;
