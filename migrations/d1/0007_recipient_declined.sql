CREATE TABLE recipient_declined_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('signer','approver')),
  routing_order INTEGER NOT NULL CHECK (routing_order BETWEEN 1 AND 1000),
  actor_type TEXT NOT NULL CHECK (actor_type = 'recipient'),
  actor_id TEXT NOT NULL CHECK (actor_id = recipient_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  sent_commit_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, recipient_id),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id)
);

CREATE INDEX recipient_declined_command_envelope
  ON recipient_declined_command(organization_id, envelope_id, updated_at DESC);

-- The command insert is the single D1 compare-and-set boundary. The trigger
-- declines and revokes the actor, revokes remaining non-completed recipient
-- capabilities without changing their status, declines the envelope, and
-- appends recipient.declined. Any failed CAS aborts the whole batch. Delivery
-- intent rows are intentionally left unchanged.
CREATE TRIGGER recipient_declined_command_publish
AFTER INSERT ON recipient_declined_command
BEGIN
  UPDATE recipient
  SET status = 'declined',
      capability_revoked_at = NEW.updated_at,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.recipient_id
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
  WHERE organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
    AND id <> NEW.recipient_id
    AND status <> 'completed'
    AND capability_hash IS NOT NULL
    AND capability_revoked_at IS NULL;

  UPDATE envelope
  SET status = 'declined',
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient declined publish conflict')
  END);

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.declined', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );
END;
