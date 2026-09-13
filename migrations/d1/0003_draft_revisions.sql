CREATE TABLE draft_revision_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_generation INTEGER NOT NULL,
  resulting_generation INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL,
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, envelope_id, resulting_generation),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CHECK (resulting_generation = expected_generation + 1),
  CHECK (audit_sequence > 1)
);

CREATE INDEX draft_revision_command_envelope
  ON draft_revision_command(organization_id, envelope_id, resulting_generation DESC);

-- D1 has transactional batch execution but no interactive transaction API.
-- Publishing is therefore attached to the command insert so a failed CAS or
-- audit constraint aborts the command row, pointer update, and event together.
CREATE TRIGGER draft_revision_command_publish
AFTER INSERT ON draft_revision_command
BEGIN
  UPDATE envelope
  SET repository_generation = NEW.resulting_generation,
      repository_head = NEW.commit_sha,
      repository_archive_key = NEW.archive_key,
      repository_archive_sha256 = NEW.archive_sha256,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = NEW.envelope_id
    AND status = 'draft'
    AND repository_generation = NEW.expected_generation
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
    WHEN changes() <> 1 THEN RAISE(ABORT, 'draft revision publish conflict')
  END);

  INSERT INTO audit_event (
    id,
    organization_id,
    envelope_id,
    sequence,
    event_type,
    actor_type,
    actor_id,
    payload_json,
    previous_hash,
    event_hash,
    occurred_at
  ) VALUES (
    NEW.audit_event_id,
    NEW.organization_id,
    NEW.envelope_id,
    NEW.audit_sequence,
    'draft.revision_created',
    NEW.actor_type,
    NEW.actor_id,
    NEW.audit_payload_json,
    NEW.previous_audit_hash,
    NEW.audit_event_hash,
    NEW.updated_at
  );
END;
