CREATE TABLE recipient (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('signer','approver','viewer','prefill','cc')),
  locale TEXT NOT NULL CHECK (locale IN ('en','ja')),
  routing_order INTEGER NOT NULL CHECK (routing_order BETWEEN 1 AND 1000),
  status TEXT NOT NULL CHECK (status IN ('pending','viewed','completed','declined')),
  capability_hash TEXT,
  capability_expires_at TEXT,
  capability_revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, email),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CONSTRAINT recipient_id_uuidv7 CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX recipient_envelope_route
  ON recipient(organization_id, envelope_id, routing_order, id);

CREATE UNIQUE INDEX recipient_capability_hash
  ON recipient(capability_hash)
  WHERE capability_hash IS NOT NULL;

CREATE TABLE envelope_ready_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  commit_sha TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 1 AND 50),
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);

CREATE INDEX envelope_ready_command_envelope
  ON envelope_ready_command(organization_id, envelope_id, updated_at DESC);

-- The command insert is the D1 compare-and-set boundary. The application adds
-- the complete recipient projection in the same D1 batch; any later statement
-- failure rolls this trigger, the command, and its audit event back together.
CREATE TRIGGER envelope_ready_command_publish
AFTER INSERT ON envelope_ready_command
BEGIN
  UPDATE envelope
  SET status = 'ready',
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.envelope_id
    AND status = 'draft'
    AND repository_generation = NEW.expected_generation
    AND repository_head = NEW.commit_sha
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'envelope ready publish conflict')
  END;

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.ready', NEW.actor_type, NEW.actor_id,
    NEW.audit_payload_json, NEW.previous_audit_hash, NEW.audit_event_hash,
    NEW.updated_at
  );
END;
