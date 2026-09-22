-- Durable instance-seal reconciliation. Provider and validator credentials,
-- private-key references, and raw remote messages never enter these tables.
CREATE TABLE pdf_seal_job (
  id TEXT NOT NULL PRIMARY KEY,
  envelope_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE,
  validation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','failed','publication_ready')),
  next_action TEXT NOT NULL CHECK (next_action IN ('submit','recover_submit','poll_provider','validate','publish')),
  claim_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  retryable INTEGER CHECK (retryable IN (0,1)),
  last_error_code TEXT,
  source_object_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_byte_size INTEGER NOT NULL CHECK (source_byte_size BETWEEN 1 AND 33554432),
  requested_profile TEXT NOT NULL CHECK (requested_profile IN ('pades-b-b','pades-b-t')),
  signer_certificate_sha256 TEXT NOT NULL,
  seal_policy_id TEXT NOT NULL,
  validation_policy_id TEXT NOT NULL,
  tsa_policy_id TEXT,
  tsa_trust_bundle_sha256 TEXT,
  provider_receipt_id TEXT,
  sealed_object_key TEXT,
  sealed_sha256 TEXT,
  sealed_byte_size INTEGER,
  achieved_profile TEXT,
  validator_receipt_id TEXT,
  validation_checks_json TEXT,
  validation_report_object_key TEXT,
  validation_report_sha256 TEXT,
  validation_report_byte_size INTEGER,
  validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_at TEXT,
  failed_at TEXT,
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact_pdf(envelope_id),
  CONSTRAINT pdf_seal_job_id_uuidv7 CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7' AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT pdf_seal_job_operation_uuidv7 CHECK (
    length(operation_id) = 36 AND substr(operation_id, 9, 1) = '-'
    AND substr(operation_id, 14, 1) = '-' AND substr(operation_id, 15, 1) = '7'
    AND substr(operation_id, 19, 1) = '-'
    AND substr(operation_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(operation_id, 24, 1) = '-'
    AND length(replace(operation_id, '-', '')) = 32
    AND replace(operation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT pdf_seal_job_validation_uuidv7 CHECK (
    length(validation_id) = 36 AND substr(validation_id, 9, 1) = '-'
    AND substr(validation_id, 14, 1) = '-' AND substr(validation_id, 15, 1) = '7'
    AND substr(validation_id, 19, 1) = '-'
    AND substr(validation_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(validation_id, 24, 1) = '-'
    AND length(replace(validation_id, '-', '')) = 32
    AND replace(validation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT pdf_seal_job_digest_shapes CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(signer_certificate_sha256) = 64
    AND signer_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (tsa_trust_bundle_sha256 IS NULL OR
      (length(tsa_trust_bundle_sha256) = 64
       AND tsa_trust_bundle_sha256 NOT GLOB '*[^0-9a-f]*'))
    AND (sealed_sha256 IS NULL OR
      (length(sealed_sha256) = 64 AND sealed_sha256 NOT GLOB '*[^0-9a-f]*'))
    AND (validation_report_sha256 IS NULL OR
      (length(validation_report_sha256) = 64
       AND validation_report_sha256 NOT GLOB '*[^0-9a-f]*'))
  ),
  CONSTRAINT pdf_seal_job_policy_tuple CHECK (
    (requested_profile = 'pades-b-b' AND tsa_policy_id IS NULL
      AND tsa_trust_bundle_sha256 IS NULL)
    OR (requested_profile = 'pades-b-t' AND tsa_policy_id IS NOT NULL
      AND tsa_trust_bundle_sha256 IS NOT NULL)
  ),
  CONSTRAINT pdf_seal_job_lease_state CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CONSTRAINT pdf_seal_job_failure_state CHECK (
    (status = 'failed' AND retryable IS NOT NULL AND last_error_code IS NOT NULL
      AND ready_at IS NULL AND ((retryable = 1 AND failed_at IS NULL)
        OR (retryable = 0 AND failed_at IS NOT NULL)))
    OR (status <> 'failed' AND retryable IS NULL AND last_error_code IS NULL AND failed_at IS NULL)
  ),
  CONSTRAINT pdf_seal_job_action_evidence CHECK (
    (next_action IN ('submit','recover_submit') AND provider_receipt_id IS NULL
      AND sealed_object_key IS NULL AND sealed_sha256 IS NULL AND sealed_byte_size IS NULL
      AND achieved_profile IS NULL AND validator_receipt_id IS NULL
      AND validation_checks_json IS NULL AND validation_report_object_key IS NULL
      AND validation_report_sha256 IS NULL AND validation_report_byte_size IS NULL
      AND validated_at IS NULL AND ready_at IS NULL)
    OR (next_action = 'poll_provider' AND provider_receipt_id IS NOT NULL
      AND sealed_object_key IS NULL AND sealed_sha256 IS NULL AND sealed_byte_size IS NULL
      AND achieved_profile IS NULL AND validator_receipt_id IS NULL
      AND validation_checks_json IS NULL AND validation_report_object_key IS NULL
      AND validation_report_sha256 IS NULL AND validation_report_byte_size IS NULL
      AND validated_at IS NULL AND ready_at IS NULL)
    OR (next_action = 'validate' AND provider_receipt_id IS NOT NULL
      AND sealed_object_key IS NOT NULL AND sealed_sha256 IS NOT NULL
      AND sealed_byte_size > source_byte_size AND sealed_byte_size <= 67108864
      AND achieved_profile = requested_profile AND validator_receipt_id IS NULL
      AND validation_checks_json IS NULL AND validation_report_object_key IS NULL
      AND validation_report_sha256 IS NULL AND validation_report_byte_size IS NULL
      AND validated_at IS NULL AND ready_at IS NULL)
    OR (next_action = 'publish' AND status = 'publication_ready'
      AND provider_receipt_id IS NOT NULL AND sealed_object_key IS NOT NULL
      AND sealed_sha256 IS NOT NULL AND sealed_byte_size > source_byte_size
      AND sealed_byte_size <= 67108864 AND achieved_profile = requested_profile
      AND validator_receipt_id IS NOT NULL AND validation_checks_json IS NOT NULL
      AND length(validation_checks_json) BETWEEN 2 AND 32768
      AND validation_report_object_key IS NOT NULL
      AND validation_report_sha256 IS NOT NULL
      AND validation_report_byte_size BETWEEN 1 AND 65536
      AND validated_at IS NOT NULL AND ready_at IS NOT NULL)
  ),
  CONSTRAINT pdf_seal_job_publish_state CHECK (
    (status = 'publication_ready' AND next_action = 'publish')
    OR (status <> 'publication_ready' AND next_action <> 'publish')
  ),
  CONSTRAINT pdf_seal_job_safe_lengths CHECK (
    length(source_object_key) BETWEEN 1 AND 1024
    AND length(seal_policy_id) BETWEEN 1 AND 128
    AND length(validation_policy_id) BETWEEN 1 AND 128
    AND (tsa_policy_id IS NULL OR length(tsa_policy_id) BETWEEN 1 AND 128)
    AND (provider_receipt_id IS NULL OR length(provider_receipt_id) BETWEEN 1 AND 256)
    AND (validator_receipt_id IS NULL OR length(validator_receipt_id) BETWEEN 1 AND 256)
    AND (last_error_code IS NULL OR length(last_error_code) BETWEEN 2 AND 65)
  )
);

CREATE INDEX pdf_seal_job_claim
  ON pdf_seal_job(status, available_at, created_at, id)
  WHERE status IN ('pending','failed');

CREATE INDEX pdf_seal_job_reclaim
  ON pdf_seal_job(locked_at, created_at, id)
  WHERE status = 'processing';

CREATE TABLE pdf_seal_attempt (
  id TEXT NOT NULL PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 8),
  action TEXT NOT NULL CHECK (action IN ('submit','recover_submit','poll_provider','validate')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'ambiguous','checkpointed','deferred','publication_ready',
    'retryable_failed','permanently_failed'
  )),
  error_code TEXT,
  provider_receipt_id TEXT,
  validator_receipt_id TEXT,
  sealed_sha256 TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  UNIQUE (job_id, attempt_number),
  FOREIGN KEY (job_id) REFERENCES pdf_seal_job(id),
  CONSTRAINT pdf_seal_attempt_id_uuidv7 CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7' AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT pdf_seal_attempt_outcome_shape CHECK (
    (outcome IN ('retryable_failed','permanently_failed') AND error_code IS NOT NULL)
    OR (outcome NOT IN ('retryable_failed','permanently_failed') AND error_code IS NULL)
  )
);

CREATE TRIGGER pdf_seal_attempt_no_update
BEFORE UPDATE ON pdf_seal_attempt
BEGIN
  SELECT RAISE(ABORT, 'pdf seal attempts are immutable');
END;

CREATE TRIGGER pdf_seal_attempt_no_delete
BEFORE DELETE ON pdf_seal_attempt
BEGIN
  SELECT RAISE(ABORT, 'pdf seal attempts are immutable');
END;
