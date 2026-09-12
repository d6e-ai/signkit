-- Completion artifact publication is a durable reconciliation job, not an
-- extension of the hot recipient sign/approve completion transactions. A
-- periodic worker discovers `completed` envelopes lacking a published
-- artifact (including envelopes that completed before this migration),
-- leases one job per envelope, and publishes exactly one immutable pointer
-- plus one chained `envelope.completion_artifact_published` audit event.
CREATE TABLE completion_artifact_job (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','published','failed')),
  claim_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0,1)),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, envelope_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL) OR
    (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CHECK (status <> 'published' OR retryable = 0)
);

CREATE INDEX completion_artifact_job_claim
  ON completion_artifact_job(status, available_at)
  WHERE status IN ('pending','failed');

CREATE INDEX completion_artifact_job_reclaim
  ON completion_artifact_job(locked_at)
  WHERE status = 'processing';

-- The published pointer. One row per envelope, ever: object bytes are
-- content-addressed and immutable, and this row is the sole SQL boundary
-- that makes a specific pair of them the envelope's completion evidence.
CREATE TABLE completion_artifact (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  manifest_sha256 TEXT NOT NULL,
  json_object_key TEXT NOT NULL,
  json_sha256 TEXT NOT NULL,
  markdown_object_key TEXT NOT NULL,
  markdown_sha256 TEXT NOT NULL,
  sent_commit_sha TEXT NOT NULL,
  field_generation INTEGER NOT NULL,
  anchor_audit_event_id TEXT NOT NULL,
  audit_head_sequence INTEGER NOT NULL,
  audit_head_event_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, envelope_id),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, anchor_audit_event_id) REFERENCES audit_event(organization_id, id)
);

CREATE TABLE completion_artifact_publish_command (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  sent_commit_sha TEXT NOT NULL,
  field_generation INTEGER NOT NULL,
  anchor_audit_event_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  json_object_key TEXT NOT NULL,
  json_sha256 TEXT NOT NULL,
  markdown_object_key TEXT NOT NULL,
  markdown_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (organization_id, envelope_id),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, anchor_audit_event_id) REFERENCES audit_event(organization_id, id)
);

-- The command insert is the sole D1 publication boundary. It rechecks the
-- envelope is still completed at the exact pinned commit/field generation,
-- that the audit head is still anchored at the immutable `envelope.completed`
-- event the evidence was built from, and that the claiming lease is still the
-- current processing lease, before publishing the pointer, marking the job
-- published, and appending the audit event. Any failed predicate rolls this
-- statement — including the command row itself — back atomically.
CREATE TRIGGER completion_artifact_publish_command_publish
AFTER INSERT ON completion_artifact_publish_command
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope
      WHERE organization_id = NEW.organization_id
        AND id = NEW.envelope_id
        AND status = 'completed'
        AND sent_commit_sha = NEW.sent_commit_sha
        AND sent_commit_sha = repository_head
        AND field_generation = NEW.field_generation
    ) THEN RAISE(ABORT, 'completion artifact envelope state conflict')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM audit_event previous
      WHERE previous.organization_id = NEW.organization_id
        AND previous.envelope_id = NEW.envelope_id
        AND previous.id = NEW.anchor_audit_event_id
        AND previous.sequence = NEW.audit_sequence - 1
        AND previous.event_hash = NEW.previous_audit_hash
        AND previous.event_type = 'envelope.completed'
    ) THEN RAISE(ABORT, 'completion artifact audit anchor conflict')
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM audit_event newer
      WHERE newer.organization_id = NEW.organization_id
        AND newer.envelope_id = NEW.envelope_id
        AND newer.sequence >= NEW.audit_sequence
    ) THEN RAISE(ABORT, 'completion artifact audit head conflict')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_artifact_job
      WHERE organization_id = NEW.organization_id
        AND envelope_id = NEW.envelope_id
        AND status = 'processing'
        AND claim_token = NEW.claim_token
    ) THEN RAISE(ABORT, 'completion artifact lease conflict')
  END;

  INSERT INTO completion_artifact (
    organization_id, envelope_id, schema_version, manifest_sha256,
    json_object_key, json_sha256, markdown_object_key, markdown_sha256,
    sent_commit_sha, field_generation, anchor_audit_event_id,
    audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
  ) VALUES (
    NEW.organization_id, NEW.envelope_id, 1, NEW.manifest_sha256,
    NEW.json_object_key, NEW.json_sha256, NEW.markdown_object_key, NEW.markdown_sha256,
    NEW.sent_commit_sha, NEW.field_generation, NEW.anchor_audit_event_id,
    NEW.audit_sequence, NEW.audit_event_hash, NEW.updated_at, NEW.audit_event_id
  );

  UPDATE completion_artifact_job
  SET status = 'published', claim_token = NULL, locked_at = NULL, retryable = 0,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND envelope_id = NEW.envelope_id
    AND status = 'processing' AND claim_token = NEW.claim_token;

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'completion artifact job update conflict')
  END;

  INSERT INTO audit_event (
    id, organization_id, envelope_id, sequence, event_type, actor_type,
    actor_id, payload_json, previous_hash, event_hash, occurred_at
  ) VALUES (
    NEW.audit_event_id, NEW.organization_id, NEW.envelope_id,
    NEW.audit_sequence, 'envelope.completion_artifact_published', 'system',
    'completion-artifact-worker', NEW.audit_payload_json, NEW.previous_audit_hash,
    NEW.audit_event_hash, NEW.updated_at
  );
END;
