-- Composite reference target so a submitted field value can be proven, at
-- the foreign-key level, to belong to the exact recipient/envelope/type of
-- the field it claims to answer.
CREATE UNIQUE INDEX envelope_field_identity
  ON envelope_field(organization_id, id, recipient_id, envelope_id, field_type);

-- Field values are declared only in SQL. Each field gets exactly one
-- immutable row for its lifetime (the primary key forbids re-signing), and
-- only a SHA-256 digest of the value ever leaves this table.
CREATE TABLE field_value (
  organization_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('signature','initials','text','date','checkbox')),
  value_json TEXT NOT NULL,
  value_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, field_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, field_id, recipient_id, envelope_id, field_type)
    REFERENCES envelope_field(organization_id, id, recipient_id, envelope_id, field_type)
);

CREATE INDEX field_value_recipient
  ON field_value(organization_id, recipient_id);

CREATE TABLE recipient_signed_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role = 'signer'),
  routing_order INTEGER NOT NULL CHECK (routing_order BETWEEN 1 AND 1000),
  actor_type TEXT NOT NULL CHECK (actor_type = 'recipient'),
  actor_id TEXT NOT NULL CHECK (actor_id = recipient_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  sent_commit_sha TEXT NOT NULL,
  expected_field_generation INTEGER NOT NULL CHECK (
    expected_field_generation BETWEEN 0 AND 2147483646
  ),
  field_values_json TEXT NOT NULL,
  field_count INTEGER NOT NULL CHECK (field_count BETWEEN 0 AND 50),
  updated_at TEXT NOT NULL,
  next_routing_order INTEGER CHECK (
    next_routing_order IS NULL OR (next_routing_order BETWEEN 1 AND 1000 AND next_routing_order > routing_order)
  ),
  next_capability_expires_at TEXT,
  released_delivery_count INTEGER NOT NULL CHECK (released_delivery_count BETWEEN 0 AND 50),
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  completed_audit_event_id TEXT,
  completed_audit_event_hash TEXT,
  completed_audit_payload_json TEXT,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, recipient_id),
  UNIQUE (organization_id, audit_event_id),
  UNIQUE (organization_id, completed_audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id),
  CHECK (
    (
      completed_audit_event_id IS NULL
      AND completed_audit_event_hash IS NULL
      AND completed_audit_payload_json IS NULL
    ) OR (
      completed_audit_event_id IS NOT NULL
      AND completed_audit_event_hash IS NOT NULL
      AND completed_audit_payload_json IS NOT NULL
      AND completed_audit_event_id <> audit_event_id
      AND next_routing_order IS NULL
      AND next_capability_expires_at IS NULL
      AND released_delivery_count = 0
    )
  ),
  CHECK (
    (
      next_routing_order IS NULL
      AND next_capability_expires_at IS NULL
      AND released_delivery_count = 0
    ) OR (
      next_routing_order IS NOT NULL
      AND next_capability_expires_at IS NOT NULL
      AND released_delivery_count > 0
      AND completed_audit_event_id IS NULL
    )
  )
);

CREATE INDEX recipient_signed_command_envelope
  ON recipient_signed_command(organization_id, envelope_id, updated_at DESC);

-- The command insert is the single D1 compare-and-set boundary, mirroring
-- recipient_approved_command_publish for the signer role: complete and
-- revoke only the actor, verify the declared field set is exactly answered,
-- then either release the next routing group, complete the envelope, or
-- leave later groups blocked. The application inserts the immutable
-- field_value rows as later statements in the same D1 batch; any later
-- statement failure (including the field-identity foreign key) rolls this
-- trigger, the command, and its audit event back together.
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

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope
      WHERE organization_id = NEW.organization_id
        AND id = NEW.envelope_id
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
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND recipient_id = NEW.recipient_id
    ) <> NEW.field_count
    THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
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
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.completed_audit_event_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
    WHEN NEW.next_routing_order IS NOT NULL AND EXISTS (
      SELECT 1 FROM recipient
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
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
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND routing_order = NEW.routing_order
        AND role IN ('signer', 'approver')
        AND status <> 'completed'
    ) THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

  SELECT (CASE
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
  END);

  UPDATE recipient
  SET capability_expires_at = NEW.next_capability_expires_at,
      updated_at = NEW.updated_at
  WHERE NEW.next_routing_order IS NOT NULL
    AND organization_id = NEW.organization_id
    AND envelope_id = NEW.envelope_id
    AND routing_order = NEW.next_routing_order
    AND role <> 'cc'
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
        AND target.role <> 'cc'
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'recipient signed publish conflict')
  END);

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

  SELECT (CASE
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
  END);
END;
