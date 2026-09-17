ALTER TABLE recipient_declined_command
  ADD COLUMN revocation_evidence_version INTEGER NOT NULL DEFAULT 1
    CHECK (revocation_evidence_version IN (1, 2));

ALTER TABLE recipient_declined_command
  ADD COLUMN revoked_recipient_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(revoked_recipient_ids_json) AND json_type(revoked_recipient_ids_json) = 'array');

ALTER TABLE recipient_declined_command
  ADD COLUMN revoked_recipient_count INTEGER NOT NULL DEFAULT 0
    CHECK (revoked_recipient_count >= 0);

DROP TRIGGER recipient_declined_command_publish;

-- Version 2 decline commands fence active provider submissions, prove the
-- exact sibling-capability revocation set, scrub every still-deliverable
-- invitation, and publish the terminal state in one D1 transaction.
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
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.declined', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );
END;
