-- Atomic optional PDF metadata on the existing publication command, plus a
-- dedicated repair job for already-published envelopes whose PDF pointer never
-- landed. Repair never rewrites the manifest, publication audit, or primary job.
ALTER TABLE completion_artifact_publish_command ADD COLUMN pdf_object_key TEXT;
ALTER TABLE completion_artifact_publish_command ADD COLUMN pdf_sha256 TEXT;
ALTER TABLE completion_artifact_publish_command ADD COLUMN pdf_byte_size INTEGER;
ALTER TABLE completion_artifact_publish_command ADD COLUMN pdf_manifest_object_key TEXT;
ALTER TABLE completion_artifact_publish_command ADD COLUMN pdf_manifest_sha256 TEXT;

DROP TRIGGER IF EXISTS completion_artifact_publish_command_publish;

CREATE TRIGGER completion_artifact_publish_command_publish
AFTER INSERT ON completion_artifact_publish_command
BEGIN
  SELECT (CASE
    WHEN (
      (NEW.pdf_object_key IS NULL)
      + (NEW.pdf_sha256 IS NULL)
      + (NEW.pdf_byte_size IS NULL)
      + (NEW.pdf_manifest_object_key IS NULL)
      + (NEW.pdf_manifest_sha256 IS NULL)
    ) NOT IN (0, 5) THEN RAISE(ABORT, 'completion artifact pdf metadata must be all-or-none')
  END);

  SELECT (CASE
    WHEN NEW.pdf_byte_size IS NOT NULL
      AND (NEW.pdf_byte_size < 1 OR NEW.pdf_byte_size > 33554432)
      THEN RAISE(ABORT, 'completion artifact pdf byte size is out of bounds')
  END);

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

  INSERT INTO completion_artifact_pdf (
    envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
    pdf_manifest_object_key, pdf_manifest_sha256, published_at
  )
  SELECT
    NEW.envelope_id, NEW.pdf_object_key, NEW.pdf_sha256, NEW.pdf_byte_size,
    NEW.pdf_manifest_object_key, NEW.pdf_manifest_sha256, NEW.updated_at
  WHERE NEW.pdf_object_key IS NOT NULL;
END;

CREATE TABLE completion_artifact_pdf_repair (
  envelope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','repaired','failed')),
  claim_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0,1)),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (envelope_id),
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact(envelope_id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL) OR
    (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CHECK (status <> 'repaired' OR retryable = 0)
);

CREATE INDEX completion_artifact_pdf_repair_claim
  ON completion_artifact_pdf_repair(status, available_at)
  WHERE status IN ('pending','failed');

CREATE INDEX completion_artifact_pdf_repair_reclaim
  ON completion_artifact_pdf_repair(locked_at)
  WHERE status = 'processing';

CREATE TABLE completion_artifact_pdf_repair_command (
  envelope_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  expected_manifest_sha256 TEXT NOT NULL,
  pdf_object_key TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL,
  pdf_byte_size INTEGER NOT NULL CHECK (pdf_byte_size BETWEEN 1 AND 33554432),
  pdf_manifest_object_key TEXT NOT NULL,
  pdf_manifest_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (envelope_id),
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact(envelope_id)
);

CREATE TRIGGER completion_artifact_pdf_repair_command_complete
AFTER INSERT ON completion_artifact_pdf_repair_command
BEGIN
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_artifact_pdf_repair
      WHERE envelope_id = NEW.envelope_id
        AND status = 'processing'
        AND claim_token = NEW.claim_token
    ) THEN RAISE(ABORT, 'completion artifact pdf repair lease conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_artifact
      WHERE envelope_id = NEW.envelope_id
        AND manifest_sha256 = NEW.expected_manifest_sha256
    ) THEN RAISE(ABORT, 'completion artifact pdf repair manifest conflict')
  END);

  INSERT OR IGNORE INTO completion_artifact_pdf (
    envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
    pdf_manifest_object_key, pdf_manifest_sha256, published_at
  ) VALUES (
    NEW.envelope_id, NEW.pdf_object_key, NEW.pdf_sha256, NEW.pdf_byte_size,
    NEW.pdf_manifest_object_key, NEW.pdf_manifest_sha256, NEW.updated_at
  );

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_artifact_pdf
      WHERE envelope_id = NEW.envelope_id
        AND pdf_object_key = NEW.pdf_object_key
        AND pdf_sha256 = NEW.pdf_sha256
        AND (pdf_byte_size IS NULL OR pdf_byte_size = NEW.pdf_byte_size)
        AND pdf_manifest_object_key = NEW.pdf_manifest_object_key
        AND pdf_manifest_sha256 = NEW.pdf_manifest_sha256
    ) THEN RAISE(ABORT, 'completion artifact pdf pointer conflict')
  END);

  UPDATE completion_artifact_pdf_repair
  SET status = 'repaired', claim_token = NULL, locked_at = NULL, retryable = 0,
      last_error = NULL, updated_at = NEW.updated_at
  WHERE envelope_id = NEW.envelope_id
    AND status = 'processing' AND claim_token = NEW.claim_token;

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'completion artifact pdf repair update conflict')
  END);
END;

-- Operator requeue receipts. `expected_failed_at` is the exact `updated_at`
-- the exhausting failure wrote: attempts alone repeat after a requeue
-- (10 -> 0 -> 10), so the failure timestamp is the generation CAS that keeps a
-- stale or duplicate command from resetting a newer job.
CREATE TABLE completion_artifact_retry_command (
  envelope_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_attempts INTEGER NOT NULL CHECK (expected_attempts >= 0),
  expected_failed_at TEXT NOT NULL,
  requeued_at TEXT NOT NULL,
  PRIMARY KEY (envelope_id, idempotency_key),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id)
);

CREATE TRIGGER completion_artifact_retry_command_requeue
AFTER INSERT ON completion_artifact_retry_command
BEGIN
  UPDATE completion_artifact_job
  SET status = 'pending', retryable = 1, attempts = 0, last_error = NULL,
      claim_token = NULL, locked_at = NULL, available_at = NEW.requeued_at,
      updated_at = NEW.requeued_at
  WHERE envelope_id = NEW.envelope_id
    AND status = 'failed'
    AND retryable = 0
    AND claim_token IS NULL
    AND locked_at IS NULL
    AND attempts = NEW.expected_attempts
    AND updated_at = NEW.expected_failed_at
    AND last_error = 'completion_artifact_attempts_exhausted';

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'completion artifact retry conflict')
  END);
END;

CREATE TABLE completion_artifact_pdf_repair_retry_command (
  envelope_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_attempts INTEGER NOT NULL CHECK (expected_attempts >= 0),
  expected_failed_at TEXT NOT NULL,
  requeued_at TEXT NOT NULL,
  PRIMARY KEY (envelope_id, idempotency_key),
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact_pdf_repair(envelope_id)
);

CREATE TRIGGER completion_artifact_pdf_repair_retry_command_requeue
AFTER INSERT ON completion_artifact_pdf_repair_retry_command
BEGIN
  UPDATE completion_artifact_pdf_repair
  SET status = 'pending', retryable = 1, attempts = 0, last_error = NULL,
      claim_token = NULL, locked_at = NULL, available_at = NEW.requeued_at,
      updated_at = NEW.requeued_at
  WHERE envelope_id = NEW.envelope_id
    AND status = 'failed'
    AND retryable = 0
    AND claim_token IS NULL
    AND locked_at IS NULL
    AND attempts = NEW.expected_attempts
    AND updated_at = NEW.expected_failed_at
    AND last_error = 'completion_artifact_pdf_repair_attempts_exhausted';

  SELECT (CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'completion artifact pdf repair retry conflict')
  END);
END;
