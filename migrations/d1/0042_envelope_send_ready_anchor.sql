-- Restore the 0009 send-publish split that 0015/0023/0036 collapsed.
-- Field placement may advance the audit head after envelope.ready, so the
-- caller-supplied ready event is an immutable Git-revision anchor and
-- envelope.sent chains from the current audit head. Recreated from 0036 with
-- 0015 observer-routing and hash_version = 2 kept intact. SQLite cannot ALTER
-- a trigger, and already-applied migrations must not be rewritten.

DROP TRIGGER IF EXISTS envelope_send_publish_guard;

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
END;
