-- Provider-portable durable DOCX conversion jobs. Source DOCX and generated
-- DOCX bytes live in object storage; Git only ever receives normalized
-- Markdown through the existing draft commit boundary.
CREATE TABLE docx_conversion_job (
  id TEXT NOT NULL PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('import','export')),
  request_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','succeeded','failed')),
  claim_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0,1)),
  last_error TEXT,
  source_object_key TEXT,
  source_sha256 TEXT,
  source_byte_size INTEGER,
  source_commit_sha TEXT,
  source_archive_key TEXT,
  source_archive_sha256 TEXT,
  target_path TEXT,
  expected_generation INTEGER,
  actor_type TEXT,
  actor_id TEXT,
  actor_name TEXT,
  actor_email TEXT,
  idempotency_key TEXT,
  result_generation INTEGER,
  result_commit_sha TEXT,
  result_archive_sha256 TEXT,
  result_object_key TEXT,
  result_sha256 TEXT,
  result_byte_size INTEGER,
  result_skipped_pdf_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (envelope_id, direction, request_key),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL) OR
    (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CHECK (status NOT IN ('succeeded') OR retryable = 0),
  CHECK (status <> 'failed' OR last_error IS NOT NULL),
  CHECK (status NOT IN ('succeeded','failed') OR completed_at IS NOT NULL OR retryable = 1),
  CHECK (
    (status <> 'succeeded' AND result_generation IS NULL AND result_commit_sha IS NULL
      AND result_archive_sha256 IS NULL AND result_object_key IS NULL
      AND result_sha256 IS NULL AND result_byte_size IS NULL
      AND result_skipped_pdf_count IS NULL)
    OR
    (status = 'succeeded' AND direction = 'import' AND result_generation IS NOT NULL
      AND result_commit_sha IS NOT NULL AND result_archive_sha256 IS NOT NULL
      AND result_object_key IS NULL AND result_sha256 IS NULL
      AND result_byte_size IS NULL AND result_skipped_pdf_count IS NULL)
    OR
    (status = 'succeeded' AND direction = 'export' AND result_generation IS NULL
      AND result_commit_sha IS NULL AND result_archive_sha256 IS NULL
      AND result_object_key IS NOT NULL AND result_sha256 IS NOT NULL
      AND result_byte_size IS NOT NULL AND result_skipped_pdf_count IS NOT NULL)
  ),
  CHECK (
    (direction = 'import' AND source_object_key IS NOT NULL AND source_sha256 IS NOT NULL
      AND source_byte_size IS NOT NULL AND target_path IS NOT NULL
      AND expected_generation IS NOT NULL AND actor_type IS NOT NULL
      AND actor_id IS NOT NULL AND actor_name IS NOT NULL AND actor_email IS NOT NULL
      AND idempotency_key IS NOT NULL
      AND source_commit_sha IS NULL AND source_archive_key IS NULL
      AND source_archive_sha256 IS NULL)
    OR
    (direction = 'export' AND source_object_key IS NULL AND source_sha256 IS NULL
      AND source_byte_size IS NULL AND target_path IS NULL
      AND expected_generation IS NULL AND actor_type IS NULL
      AND actor_id IS NULL AND actor_name IS NULL AND actor_email IS NULL
      AND idempotency_key IS NULL AND source_commit_sha IS NOT NULL
      AND source_archive_key IS NOT NULL AND source_archive_sha256 IS NOT NULL)
  )
);

CREATE INDEX docx_conversion_job_claim
  ON docx_conversion_job(status, available_at)
  WHERE status IN ('pending','failed');

CREATE INDEX docx_conversion_job_reclaim
  ON docx_conversion_job(locked_at)
  WHERE status = 'processing';

CREATE INDEX docx_conversion_job_active_source
  ON docx_conversion_job(source_object_key)
  WHERE source_object_key IS NOT NULL
    AND (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1));

CREATE INDEX docx_conversion_job_succeeded_result
  ON docx_conversion_job(result_object_key)
  WHERE status = 'succeeded' AND result_object_key IS NOT NULL;

CREATE TABLE docx_conversion_attempt (
  id TEXT NOT NULL PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','retryable_failed','permanently_failed')),
  error_code TEXT,
  source_sha256 TEXT,
  result_sha256 TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  UNIQUE (job_id, attempt_number),
  FOREIGN KEY (job_id) REFERENCES docx_conversion_job(id),
  CHECK (
    (outcome = 'succeeded' AND error_code IS NULL AND result_sha256 IS NOT NULL) OR
    (outcome <> 'succeeded' AND error_code IS NOT NULL AND result_sha256 IS NULL)
  )
);

CREATE TRIGGER docx_conversion_attempt_no_update
BEFORE UPDATE ON docx_conversion_attempt
BEGIN
  SELECT RAISE(ABORT, 'docx conversion attempts are immutable');
END;

CREATE TRIGGER docx_conversion_attempt_no_delete
BEFORE DELETE ON docx_conversion_attempt
BEGIN
  SELECT RAISE(ABORT, 'docx conversion attempts are immutable');
END;
