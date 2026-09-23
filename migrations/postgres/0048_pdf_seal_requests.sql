-- Immutable receipt for an explicit request to seal one envelope's already
-- rendered completion PDF. The transaction freezes the source bytes and policy
-- while creating the corresponding job. No provider secret is persisted.
CREATE TABLE pdf_seal_request_command (
  actor_type text NOT NULL CHECK (actor_type IN ('user','agent')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  envelope_id text NOT NULL UNIQUE REFERENCES envelope(id),
  job_id text NOT NULL UNIQUE REFERENCES pdf_seal_job(id),
  operation_id text NOT NULL UNIQUE,
  validation_id text NOT NULL UNIQUE,
  source_object_key text NOT NULL,
  source_sha256 text NOT NULL,
  source_byte_size integer NOT NULL CHECK (source_byte_size BETWEEN 1 AND 33554432),
  requested_profile text NOT NULL CHECK (requested_profile IN ('pades-b-b','pades-b-t')),
  signer_certificate_sha256 text NOT NULL,
  seal_policy_id text NOT NULL,
  validation_policy_id text NOT NULL,
  tsa_policy_id text,
  tsa_trust_bundle_sha256 text,
  requested_at timestamptz NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  CONSTRAINT pdf_seal_request_actor_bound CHECK (
    char_length(actor_id) BETWEEN 1 AND 200 AND actor_id = btrim(actor_id)
    AND actor_id ~ '^[ -~]+$'
  ),
  CONSTRAINT pdf_seal_request_idempotency_bound CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key ~ '^[!-~]+$'
  ),
  CONSTRAINT pdf_seal_request_uuidv7 CHECK (
    envelope_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND job_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND validation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT pdf_seal_request_digest_shapes CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND source_sha256 ~ '^[0-9a-f]{64}$'
    AND signer_certificate_sha256 ~ '^[0-9a-f]{64}$'
    AND (tsa_trust_bundle_sha256 IS NULL OR tsa_trust_bundle_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT pdf_seal_request_policy_tuple CHECK (
    (requested_profile = 'pades-b-b' AND tsa_policy_id IS NULL
      AND tsa_trust_bundle_sha256 IS NULL)
    OR (requested_profile = 'pades-b-t' AND tsa_policy_id IS NOT NULL
      AND tsa_trust_bundle_sha256 IS NOT NULL)
  ),
  CONSTRAINT pdf_seal_request_safe_lengths CHECK (
    char_length(source_object_key) BETWEEN 1 AND 1024
    AND char_length(seal_policy_id) BETWEEN 1 AND 128 AND seal_policy_id ~ '^[!-~]+$'
    AND char_length(validation_policy_id) BETWEEN 1 AND 128
      AND validation_policy_id ~ '^[!-~]+$'
    AND (tsa_policy_id IS NULL OR
      (char_length(tsa_policy_id) BETWEEN 1 AND 128 AND tsa_policy_id ~ '^[!-~]+$'))
  )
);

CREATE FUNCTION reject_pdf_seal_request_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pdf seal request commands are immutable';
END;
$$;

CREATE TRIGGER pdf_seal_request_command_no_update_or_delete
BEFORE UPDATE OR DELETE ON pdf_seal_request_command
FOR EACH ROW EXECUTE FUNCTION reject_pdf_seal_request_mutation();
