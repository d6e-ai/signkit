-- Post-send invitations are issued only to action-bearing recipients and
-- co-routed viewers. Prefill is a pre-send authoring role, while CC delivery
-- belongs to a future completion-artifact flow.
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
        AND previous.id = command.ready_audit_event_id
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

-- Defense in depth for legacy prefill rows: even a direct viewed-command
-- insert cannot turn a pre-send-only recipient into a post-send reader.
DROP TRIGGER recipient_viewed_command_publish;

CREATE TRIGGER recipient_viewed_command_publish
AFTER INSERT ON recipient_viewed_command
BEGIN
  UPDATE recipient
  SET status = 'viewed',
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.recipient_id
    AND envelope_id = NEW.envelope_id
    AND status = 'pending'
    AND role = NEW.recipient_role
    AND role IN ('signer', 'approver', 'viewer')
    AND routing_order = NEW.routing_order
    AND capability_hash = NEW.capability_hash
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NOT NULL
    AND julianday(capability_expires_at) > julianday(NEW.updated_at);

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient viewed publish conflict')
  END;

  UPDATE envelope
  SET status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.envelope_id
    AND status IN ('sent', 'in_progress')
    AND sent_commit_sha = NEW.sent_commit_sha
    AND sent_commit_sha = repository_head
    AND EXISTS (
      SELECT 1 FROM audit_event previous
      WHERE previous.organization_id = NEW.organization_id
        AND previous.envelope_id = NEW.envelope_id
        AND previous.sequence = NEW.audit_sequence - 1
        AND previous.event_hash = NEW.previous_audit_hash
    )
    AND NOT EXISTS (
      SELECT 1 FROM audit_event newer
      WHERE newer.organization_id = NEW.organization_id
        AND newer.envelope_id = NEW.envelope_id
        AND newer.sequence >= NEW.audit_sequence
    );

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient viewed publish conflict')
  END;

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.viewed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );
END;

-- Final completion is also a terminal delivery boundary. These BEFORE
-- triggers share the command insert's statement transaction with the publish
-- trigger, so a fence, cleanup, CAS, field, or audit failure rolls everything
-- back. Existing command rows are untouched and remain replayable.
CREATE TRIGGER recipient_approved_completion_guard
BEFORE INSERT ON recipient_approved_command
WHEN NEW.completed_audit_event_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND status = 'processing'
    ) THEN RAISE(ABORT, 'recipient approved delivery in flight')
  END;

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
    AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable = 1));

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND (status IN ('blocked', 'pending', 'processing')
          OR (status = 'failed' AND retryable = 1)
          OR sealed_capability IS NOT NULL)
    ) THEN RAISE(ABORT, 'recipient approved delivery cleanup conflict')
  END;

  UPDATE recipient
  SET capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
    AND id <> NEW.recipient_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;
END;

CREATE TRIGGER recipient_signed_completion_guard
BEFORE INSERT ON recipient_signed_command
WHEN NEW.completed_audit_event_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND status = 'processing'
    ) THEN RAISE(ABORT, 'recipient signed delivery in flight')
  END;

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
    AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable = 1));

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM delivery_outbox
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND (status IN ('blocked', 'pending', 'processing')
          OR (status = 'failed' AND retryable = 1)
          OR sealed_capability IS NOT NULL)
    ) THEN RAISE(ABORT, 'recipient signed delivery cleanup conflict')
  END;

  UPDATE recipient
  SET capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
    AND id <> NEW.recipient_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;
END;

DROP TRIGGER recipient_approved_command_publish;

CREATE TRIGGER recipient_approved_command_publish
AFTER INSERT ON recipient_approved_command
BEGIN
  UPDATE recipient
  SET status = 'completed',
      capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.recipient_id
    AND envelope_id = NEW.envelope_id
    AND status = 'viewed'
    AND role = 'approver'
    AND role = NEW.recipient_role
    AND routing_order = NEW.routing_order
    AND capability_hash = NEW.capability_hash
    AND capability_revoked_at IS NULL
    AND capability_expires_at IS NOT NULL
    AND julianday(capability_expires_at) > julianday(NEW.updated_at);

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       julianday(NEW.next_capability_expires_at) <= julianday(NEW.updated_at)
       OR julianday(NEW.next_capability_expires_at) > julianday(NEW.updated_at, '+15 days')
     )
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  SELECT CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  SELECT CASE
    WHEN NEW.completed_audit_event_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  SELECT CASE
    WHEN NEW.next_routing_order IS NULL
     AND NEW.completed_audit_event_id IS NULL
     AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       SELECT MIN(routing_order) FROM recipient
       WHERE organization_id = NEW.organization_id
         AND envelope_id = NEW.envelope_id
         AND role IN ('signer', 'approver')
         AND status <> 'completed'
         AND routing_order > NEW.routing_order
     ) IS NOT NEW.next_routing_order
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

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

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL AND changes() <> NEW.released_delivery_count
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

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

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL AND changes() <> NEW.released_delivery_count
    THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  UPDATE envelope
  SET status = CASE
        WHEN NEW.completed_audit_event_id IS NOT NULL THEN 'completed'
        WHEN status = 'sent' THEN 'in_progress'
        ELSE status
      END,
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

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.approved', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  )
  SELECT NEW.completed_audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence + 1, 'envelope.completed', NEW.actor_type, NEW.actor_id,
    NEW.completed_audit_payload_json, NEW.audit_event_hash, NEW.completed_audit_event_hash,
    NEW.updated_at
  WHERE NEW.completed_audit_event_id IS NOT NULL;

  SELECT CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND (
      SELECT COUNT(*) FROM audit_event
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND id = NEW.completed_audit_event_id
        AND sequence = NEW.audit_sequence + 1
        AND event_type = 'envelope.completed'
        AND previous_hash = NEW.audit_event_hash
        AND event_hash = NEW.completed_audit_event_hash
    ) <> 1 THEN RAISE(ABORT, 'recipient approved publish conflict')
  END;
END;

DROP TRIGGER recipient_signed_command_publish;

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

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope
      WHERE organization_id = NEW.organization_id
        AND id = NEW.envelope_id
        AND field_generation = NEW.expected_field_generation
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
    WHEN json_array_length(NEW.field_values_json) <> NEW.field_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
    WHEN (
      SELECT COUNT(*) FROM envelope_field
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND recipient_id = NEW.recipient_id
    ) <> NEW.field_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
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
  END;

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL
     AND (
       julianday(NEW.next_capability_expires_at) <= julianday(NEW.updated_at)
       OR julianday(NEW.next_capability_expires_at) > julianday(NEW.updated_at, '+15 days')
     )
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
    WHEN NEW.completed_audit_event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
    WHEN NEW.completed_audit_event_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  SELECT CASE
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
  END;

  SELECT CASE
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
  END;

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

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL AND changes() <> NEW.released_delivery_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

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

  SELECT CASE
    WHEN NEW.next_routing_order IS NOT NULL AND changes() <> NEW.released_delivery_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  UPDATE envelope
  SET status = CASE
        WHEN NEW.completed_audit_event_id IS NOT NULL THEN 'completed'
        WHEN status = 'sent' THEN 'in_progress'
        ELSE status
      END,
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

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END;

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.signed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  )
  SELECT NEW.completed_audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence + 1, 'envelope.completed', NEW.actor_type, NEW.actor_id,
    NEW.completed_audit_payload_json, NEW.audit_event_hash, NEW.completed_audit_event_hash,
    NEW.updated_at
  WHERE NEW.completed_audit_event_id IS NOT NULL;

  SELECT CASE
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
  END;
END;
