-- Immutable receipt for an explicit request to seal one envelope's already
-- rendered completion PDF. The request freezes both the source bytes and the
-- selected policy. Provider credentials and private-key references never
-- enter this table.
CREATE TABLE pdf_seal_request_command (
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  envelope_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE,
  validation_id TEXT NOT NULL UNIQUE,
  source_object_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_byte_size INTEGER NOT NULL CHECK (source_byte_size BETWEEN 1 AND 33554432),
  requested_profile TEXT NOT NULL CHECK (requested_profile IN ('pades-b-b','pades-b-t')),
  signer_certificate_sha256 TEXT NOT NULL,
  seal_policy_id TEXT NOT NULL,
  validation_policy_id TEXT NOT NULL,
  tsa_policy_id TEXT,
  tsa_trust_bundle_sha256 TEXT,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CONSTRAINT pdf_seal_request_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200 AND actor_id = trim(actor_id)
    AND actor_id NOT GLOB '*[^ -~]*'
  ),
  CONSTRAINT pdf_seal_request_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT pdf_seal_request_uuidv7 CHECK (
    length(envelope_id) = 36 AND substr(envelope_id, 15, 1) = '7'
    AND substr(envelope_id, 20, 1) IN ('8','9','a','b')
    AND length(replace(envelope_id, '-', '')) = 32
    AND replace(envelope_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND length(job_id) = 36 AND substr(job_id, 15, 1) = '7'
    AND substr(job_id, 20, 1) IN ('8','9','a','b')
    AND length(replace(job_id, '-', '')) = 32
    AND replace(job_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND length(operation_id) = 36 AND substr(operation_id, 15, 1) = '7'
    AND substr(operation_id, 20, 1) IN ('8','9','a','b')
    AND length(replace(operation_id, '-', '')) = 32
    AND replace(operation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND length(validation_id) = 36 AND substr(validation_id, 15, 1) = '7'
    AND substr(validation_id, 20, 1) IN ('8','9','a','b')
    AND length(replace(validation_id, '-', '')) = 32
    AND replace(validation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT pdf_seal_request_digest_shapes CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
    AND length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(signer_certificate_sha256) = 64
    AND signer_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (tsa_trust_bundle_sha256 IS NULL OR
      (length(tsa_trust_bundle_sha256) = 64
       AND tsa_trust_bundle_sha256 NOT GLOB '*[^0-9a-f]*'))
  ),
  CONSTRAINT pdf_seal_request_policy_tuple CHECK (
    (requested_profile = 'pades-b-b' AND tsa_policy_id IS NULL
      AND tsa_trust_bundle_sha256 IS NULL)
    OR (requested_profile = 'pades-b-t' AND tsa_policy_id IS NOT NULL
      AND tsa_trust_bundle_sha256 IS NOT NULL)
  ),
  CONSTRAINT pdf_seal_request_safe_lengths CHECK (
    length(source_object_key) BETWEEN 1 AND 1024
    AND length(seal_policy_id) BETWEEN 1 AND 128
    AND seal_policy_id NOT GLOB '*[^!-~]*'
    AND length(validation_policy_id) BETWEEN 1 AND 128
    AND validation_policy_id NOT GLOB '*[^!-~]*'
    AND (tsa_policy_id IS NULL OR
      (length(tsa_policy_id) BETWEEN 1 AND 128 AND tsa_policy_id NOT GLOB '*[^!-~]*'))
  ),
  CONSTRAINT pdf_seal_request_requested_at_iso CHECK (
    length(requested_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', requested_at) IS requested_at
  )
);

-- The command insert is the D1 transaction boundary. It may only freeze the
-- exact current completion PDF row, then creates the initial job in the same
-- statement. Any failed predicate rolls the command row back too.
CREATE TRIGGER pdf_seal_request_enqueue
AFTER INSERT ON pdf_seal_request_command
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM completion_artifact_pdf
    WHERE envelope_id = NEW.envelope_id
      AND pdf_object_key = NEW.source_object_key
      AND pdf_sha256 = NEW.source_sha256
      AND pdf_byte_size = NEW.source_byte_size
  ) THEN RAISE(ABORT, 'pdf seal request source unavailable') END);

  INSERT INTO pdf_seal_job (
    id, envelope_id, operation_id, validation_id, status, next_action,
    claim_token, attempt_sequence, retry_failures, available_at, locked_at,
    retryable, last_error_code, source_object_key, source_sha256, source_byte_size,
    requested_profile, signer_certificate_sha256, seal_policy_id,
    validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, created_at, updated_at
  ) VALUES (
    NEW.job_id, NEW.envelope_id, NEW.operation_id, NEW.validation_id, 'pending', 'submit',
    NULL, 0, 0, NEW.requested_at, NULL, NULL, NULL, NEW.source_object_key,
    NEW.source_sha256, NEW.source_byte_size, NEW.requested_profile,
    NEW.signer_certificate_sha256, NEW.seal_policy_id, NEW.validation_policy_id,
    NEW.tsa_policy_id, NEW.tsa_trust_bundle_sha256, NEW.requested_at, NEW.requested_at
  );
END;

CREATE TRIGGER pdf_seal_request_command_no_update
BEFORE UPDATE ON pdf_seal_request_command
BEGIN
  SELECT RAISE(ABORT, 'pdf seal request commands are immutable');
END;

CREATE TRIGGER pdf_seal_request_command_no_delete
BEFORE DELETE ON pdf_seal_request_command
BEGIN
  SELECT RAISE(ABORT, 'pdf seal request commands are immutable');
END;
