-- Provider-portable durable DOCX conversion jobs. Source DOCX and generated
-- DOCX bytes live in object storage; Git only ever receives normalized
-- Markdown through the existing draft commit boundary.
CREATE TABLE docx_conversion_job (
  id text NOT NULL PRIMARY KEY,
  envelope_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('import','export')),
  request_key text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','succeeded','failed')),
  claim_token text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  retryable boolean NOT NULL DEFAULT true,
  last_error text,
  source_object_key text,
  source_sha256 text,
  source_byte_size integer,
  source_commit_sha text,
  source_archive_key text,
  source_archive_sha256 text,
  target_path text,
  expected_generation integer,
  actor_type text,
  actor_id text,
  actor_name text,
  actor_email text,
  idempotency_key text,
  result_generation integer,
  result_commit_sha text,
  result_archive_sha256 text,
  result_object_key text,
  result_sha256 text,
  result_byte_size integer,
  result_skipped_pdf_count integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (envelope_id, direction, request_key),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL) OR
    (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CHECK (status <> 'succeeded' OR NOT retryable),
  CHECK (status <> 'failed' OR last_error IS NOT NULL),
  CHECK (status NOT IN ('succeeded','failed') OR completed_at IS NOT NULL OR retryable),
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
    AND (status IN ('pending','processing') OR (status = 'failed' AND retryable));

CREATE INDEX docx_conversion_job_succeeded_result
  ON docx_conversion_job(result_object_key)
  WHERE status = 'succeeded' AND result_object_key IS NOT NULL;

CREATE TABLE docx_conversion_attempt (
  id text NOT NULL PRIMARY KEY,
  job_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','retryable_failed','permanently_failed')),
  error_code text,
  source_sha256 text,
  result_sha256 text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  UNIQUE (job_id, attempt_number),
  FOREIGN KEY (job_id) REFERENCES docx_conversion_job(id),
  CHECK (
    (outcome = 'succeeded' AND error_code IS NULL AND result_sha256 IS NOT NULL) OR
    (outcome <> 'succeeded' AND error_code IS NOT NULL AND result_sha256 IS NULL)
  )
);

CREATE FUNCTION reject_docx_conversion_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'docx conversion attempts are immutable';
END;
$$;

CREATE TRIGGER docx_conversion_attempt_no_update_or_delete
BEFORE UPDATE OR DELETE ON docx_conversion_attempt
FOR EACH ROW EXECUTE FUNCTION reject_docx_conversion_attempt_mutation();
