CREATE TABLE recipient_viewed_command (
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('signer','approver','viewer','prefill','cc')),
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
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (recipient_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id)
);

CREATE INDEX recipient_viewed_command_envelope
  ON recipient_viewed_command(envelope_id, updated_at DESC);

-- The command insert is the single D1 compare-and-set boundary. The trigger
-- performs the recipient transition, the optional envelope transition, and
-- the audit append itself, so any failed CAS or audit-head check aborts the
-- whole batch and rolls back the command, recipient, envelope, and audit
-- writes together.
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
    AND role <> 'cc'
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient viewed publish conflict')
  END);

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id,
    NEW.audit_sequence, 'recipient.viewed', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );
END;
