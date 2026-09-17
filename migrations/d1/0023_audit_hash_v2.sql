-- Audit hash v3: the single hash version. Its preimage is instance-scoped
-- (no tenant field) and includes hashVersion, actorType, and actorId for
-- every event. Old databases must be reset; there is no upgrade path.
-- Recreated command triggers stamp hash_version = 3 on every new
-- audit_event insert.

ALTER TABLE audit_event ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 3;

-- SQLite has no ALTER COLUMN ... SET DEFAULT. New application INSERTs and the
-- recreated triggers below write hash_version = 3 explicitly.

DROP TRIGGER IF EXISTS draft_revision_command_publish;
DROP TRIGGER IF EXISTS envelope_ready_command_publish;
DROP TRIGGER IF EXISTS envelope_send_publish_guard;
DROP TRIGGER IF EXISTS recipient_viewed_command_publish;
DROP TRIGGER IF EXISTS recipient_declined_command_publish;
DROP TRIGGER IF EXISTS recipient_approved_command_publish;
DROP TRIGGER IF EXISTS envelope_field_placement_command_publish;
DROP TRIGGER IF EXISTS recipient_signed_command_publish;
DROP TRIGGER IF EXISTS envelope_void_command_publish;
DROP TRIGGER IF EXISTS completion_artifact_publish_command_publish;

-- Recreated from 0003_draft_revisions.sql
CREATE TRIGGER draft_revision_command_publish
AFTER INSERT ON draft_revision_command
BEGIN
  UPDATE envelope
  SET repository_generation = NEW.resulting_generation,
      repository_head = NEW.commit_sha,
      repository_archive_key = NEW.archive_key,
      repository_archive_sha256 = NEW.archive_sha256,
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status = 'draft'
    AND repository_generation = NEW.expected_generation
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'draft revision publish conflict')
  END);

  INSERT INTO audit_event (
    id,
    envelope_id,
    sequence,
    event_type,
    actor_type,
    actor_id,
    payload_json,
    previous_hash,
    event_hash,
    occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id,
    NEW.envelope_id,
    NEW.audit_sequence,
    'draft.revision_created',
    NEW.actor_type,
    NEW.actor_id,
    NEW.audit_payload_json,
    NEW.previous_audit_hash,
    NEW.audit_event_hash,
    NEW.updated_at,
    3);
END;

-- Recreated from 0004_envelope_ready.sql
CREATE TRIGGER envelope_ready_command_publish
AFTER INSERT ON envelope_ready_command
BEGIN
  UPDATE envelope
  SET status = 'ready',
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status = 'draft'
    AND repository_generation = NEW.expected_generation
    AND repository_head = NEW.commit_sha
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope ready publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.ready', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at,
    3);
END;

-- Recreated from 0015_observer_routing_semantics.sql
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

-- Recreated from 0015_observer_routing_semantics.sql
CREATE TRIGGER recipient_viewed_command_publish
AFTER INSERT ON recipient_viewed_command
BEGIN
  UPDATE recipient
  SET status = 'viewed',
      updated_at = NEW.updated_at
  WHERE id = NEW.recipient_id
    AND envelope_id = NEW.envelope_id
    AND status = 'pending'
    AND role = NEW.recipient_role
    AND role IN ('signer', 'approver', 'viewer')
    AND routing_order = NEW.routing_order
    AND capability_hash = NEW.capability_hash
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NOT NULL
    AND julianday(capability_expires_at) > julianday(NEW.updated_at);

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient viewed publish conflict')
  END);

  UPDATE envelope
  SET status = (CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END),
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status IN ('sent', 'in_progress')
    AND sent_commit_sha = NEW.sent_commit_sha
    AND sent_commit_sha = repository_head
    AND EXISTS (
      SELECT 1 FROM audit_event previous
      WHERE previous.envelope_id = NEW.envelope_id
        AND previous.sequence = NEW.audit_sequence - 1
        AND previous.event_hash = NEW.previous_audit_hash
    )
    AND NOT EXISTS (
      SELECT 1 FROM audit_event newer
      WHERE newer.envelope_id = NEW.envelope_id
        AND newer.sequence >= NEW.audit_sequence
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient viewed publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.viewed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at,
    3);
END;

-- Recreated from 0013_terminal_delivery_cleanup.sql
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
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.declined', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at,
    3);
END;

-- Recreated from 0015_observer_routing_semantics.sql
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
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.approved', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at,
    3);

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

-- Recreated from 0009_field_placement.sql
CREATE TRIGGER envelope_field_placement_command_publish
AFTER INSERT ON envelope_field_placement_command
BEGIN
  UPDATE envelope
  SET field_generation = NEW.expected_field_generation + 1,
      updated_at = NEW.updated_at
  WHERE id = NEW.envelope_id
    AND status = 'ready'
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
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.fields_json) field
      WHERE NOT EXISTS (
        SELECT 1
        FROM recipient r
        WHERE r.envelope_id = NEW.envelope_id
          AND r.id = json_extract(field.value, '$.recipientId')
          AND r.role = 'signer'
      )
    );

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'field placement publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.fields_placed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at,
    3);
END;

-- Recreated from 0015_observer_routing_semantics.sql
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
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.signed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at,
    3);

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

-- Recreated from 0014_envelope_voided.sql
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

-- Recreated from 0016_completion_artifacts.sql
CREATE TRIGGER completion_artifact_publish_command_publish
AFTER INSERT ON completion_artifact_publish_command
BEGIN
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope
      WHERE id = NEW.envelope_id
        AND status = 'completed'
        AND sent_commit_sha = NEW.sent_commit_sha
        AND sent_commit_sha = repository_head
        AND field_generation = NEW.field_generation
    ) THEN RAISE(ABORT, 'completion artifact envelope state conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM audit_event previous
      WHERE previous.envelope_id = NEW.envelope_id
        AND previous.id = NEW.anchor_audit_event_id
        AND previous.sequence = NEW.audit_sequence - 1
        AND previous.event_hash = NEW.previous_audit_hash
        AND previous.event_type = 'envelope.completed'
    ) THEN RAISE(ABORT, 'completion artifact audit anchor conflict')
  END);

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM audit_event newer
      WHERE newer.envelope_id = NEW.envelope_id
        AND newer.sequence >= NEW.audit_sequence
    ) THEN RAISE(ABORT, 'completion artifact audit head conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_artifact_job
      WHERE envelope_id = NEW.envelope_id
        AND status = 'processing'
        AND claim_token = NEW.claim_token
    ) THEN RAISE(ABORT, 'completion artifact lease conflict')
  END);

  INSERT INTO completion_artifact (
    envelope_id, schema_version, manifest_sha256,
    json_object_key, json_sha256, markdown_object_key, markdown_sha256,
    sent_commit_sha, field_generation, anchor_audit_event_id,
    audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
  ) VALUES (
    NEW.envelope_id, 1, NEW.manifest_sha256,
    NEW.json_object_key, NEW.json_sha256, NEW.markdown_object_key, NEW.markdown_sha256,
    NEW.sent_commit_sha, NEW.field_generation, NEW.anchor_audit_event_id,
    NEW.audit_sequence, NEW.audit_event_hash, NEW.updated_at, NEW.audit_event_id
  );

  UPDATE completion_artifact_job
  SET status = 'published', claim_token = NULL, locked_at = NULL, retryable = 0,
      updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND status = 'processing' AND claim_token = NEW.claim_token;

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'completion artifact job update conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at,
    hash_version) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.completion_artifact_published', 'system',
    'completion-artifact-worker', NEW.audit_payload_json, NEW.previous_audit_hash,
    NEW.audit_event_hash, NEW.updated_at,
    3);
END;
