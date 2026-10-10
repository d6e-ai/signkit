-- Atomic PDF seal publication: promotes an already `publication_ready` job's
-- frozen source/policy/provider/validator evidence into one immutable
-- pointer plus a chained `envelope.pdf_seal_published` audit event.
-- `pdf_seal_job` is never mutated by publication: discovery excludes an
-- envelope that already has a publication row, and the public seal state is
-- derived from this table's presence, not from `pdf_seal_job.status`.
CREATE INDEX pdf_seal_job_publication_ready
  ON pdf_seal_job(ready_at, id)
  WHERE status = 'publication_ready';

CREATE TABLE pdf_seal_publication (
  job_id text NOT NULL REFERENCES pdf_seal_job(id),
  envelope_id text NOT NULL REFERENCES pdf_seal_job(envelope_id),
  operation_id text NOT NULL,
  validation_id text NOT NULL,
  source_object_key text NOT NULL,
  source_sha256 text NOT NULL,
  source_byte_size integer NOT NULL,
  requested_profile text NOT NULL CHECK (requested_profile IN ('pades-b-b','pades-b-t')),
  signer_certificate_sha256 text NOT NULL,
  seal_policy_id text NOT NULL,
  validation_policy_id text NOT NULL,
  tsa_policy_id text,
  tsa_trust_bundle_sha256 text,
  provider_receipt_id text NOT NULL,
  sealed_object_key text NOT NULL,
  sealed_sha256 text NOT NULL,
  sealed_byte_size integer NOT NULL,
  achieved_profile text NOT NULL CHECK (achieved_profile IN ('pades-b-b','pades-b-t')),
  validator_receipt_id text NOT NULL,
  validation_checks_json text NOT NULL,
  validation_report_object_key text NOT NULL,
  validation_report_sha256 text NOT NULL,
  validation_report_byte_size integer NOT NULL,
  validated_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  anchor_audit_event_id text NOT NULL REFERENCES audit_event(id),
  audit_head_sequence integer NOT NULL CHECK (audit_head_sequence > 1),
  audit_head_event_hash text NOT NULL,
  audit_event_id text NOT NULL,
  PRIMARY KEY (envelope_id),
  UNIQUE (job_id),
  UNIQUE (audit_event_id),
  CONSTRAINT pdf_seal_publication_digest_shapes CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
    AND signer_certificate_sha256 ~ '^[0-9a-f]{64}$'
    AND (tsa_trust_bundle_sha256 IS NULL OR tsa_trust_bundle_sha256 ~ '^[0-9a-f]{64}$')
    AND sealed_sha256 ~ '^[0-9a-f]{64}$'
    AND validation_report_sha256 ~ '^[0-9a-f]{64}$'
    AND audit_head_event_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT pdf_seal_publication_policy_tuple CHECK (
    (requested_profile = 'pades-b-b' AND tsa_policy_id IS NULL
      AND tsa_trust_bundle_sha256 IS NULL)
    OR (requested_profile = 'pades-b-t' AND tsa_policy_id IS NOT NULL
      AND tsa_trust_bundle_sha256 IS NOT NULL)
  ),
  CONSTRAINT pdf_seal_publication_achieved_profile CHECK (achieved_profile = requested_profile),
  CONSTRAINT pdf_seal_publication_safe_lengths CHECK (
    length(source_object_key) BETWEEN 1 AND 1024
    AND length(sealed_object_key) BETWEEN 1 AND 1024
    AND length(validation_report_object_key) BETWEEN 1 AND 1024
    AND length(seal_policy_id) BETWEEN 1 AND 128
    AND length(validation_policy_id) BETWEEN 1 AND 128
    AND (tsa_policy_id IS NULL OR length(tsa_policy_id) BETWEEN 1 AND 128)
    AND length(provider_receipt_id) BETWEEN 1 AND 256
    AND length(validator_receipt_id) BETWEEN 1 AND 256
    AND length(validation_checks_json) BETWEEN 2 AND 32768
  ),
  CONSTRAINT pdf_seal_publication_bounds CHECK (
    source_byte_size BETWEEN 1 AND 33554432
    AND sealed_byte_size > source_byte_size AND sealed_byte_size <= 67108864
    AND validation_report_byte_size BETWEEN 1 AND 65536
  ),
  CONSTRAINT pdf_seal_publication_time_order CHECK (published_at >= validated_at)
);

CREATE TABLE pdf_seal_publish_command (
  job_id text NOT NULL PRIMARY KEY REFERENCES pdf_seal_job(id),
  envelope_id text NOT NULL UNIQUE REFERENCES pdf_seal_job(envelope_id),
  operation_id text NOT NULL,
  validation_id text NOT NULL,
  source_object_key text NOT NULL,
  source_sha256 text NOT NULL,
  source_byte_size integer NOT NULL,
  requested_profile text NOT NULL CHECK (requested_profile IN ('pades-b-b','pades-b-t')),
  signer_certificate_sha256 text NOT NULL,
  seal_policy_id text NOT NULL,
  validation_policy_id text NOT NULL,
  tsa_policy_id text,
  tsa_trust_bundle_sha256 text,
  provider_receipt_id text NOT NULL,
  sealed_object_key text NOT NULL,
  sealed_sha256 text NOT NULL,
  sealed_byte_size integer NOT NULL,
  achieved_profile text NOT NULL CHECK (achieved_profile IN ('pades-b-b','pades-b-t')),
  validator_receipt_id text NOT NULL,
  validation_checks_json text NOT NULL,
  validation_report_object_key text NOT NULL,
  validation_report_sha256 text NOT NULL,
  validation_report_byte_size integer NOT NULL,
  validated_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  anchor_audit_event_id text NOT NULL REFERENCES audit_event(id),
  audit_sequence integer NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_id text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  UNIQUE (audit_event_id),
  CONSTRAINT pdf_seal_publish_command_digest_shapes CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
    AND signer_certificate_sha256 ~ '^[0-9a-f]{64}$'
    AND (tsa_trust_bundle_sha256 IS NULL OR tsa_trust_bundle_sha256 ~ '^[0-9a-f]{64}$')
    AND sealed_sha256 ~ '^[0-9a-f]{64}$'
    AND validation_report_sha256 ~ '^[0-9a-f]{64}$'
    AND previous_audit_hash ~ '^[0-9a-f]{64}$'
    AND audit_event_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT pdf_seal_publish_command_policy_tuple CHECK (
    (requested_profile = 'pades-b-b' AND tsa_policy_id IS NULL
      AND tsa_trust_bundle_sha256 IS NULL)
    OR (requested_profile = 'pades-b-t' AND tsa_policy_id IS NOT NULL
      AND tsa_trust_bundle_sha256 IS NOT NULL)
  ),
  CONSTRAINT pdf_seal_publish_command_achieved_profile CHECK (achieved_profile = requested_profile),
  CONSTRAINT pdf_seal_publish_command_safe_lengths CHECK (
    length(source_object_key) BETWEEN 1 AND 1024
    AND length(sealed_object_key) BETWEEN 1 AND 1024
    AND length(validation_report_object_key) BETWEEN 1 AND 1024
    AND length(seal_policy_id) BETWEEN 1 AND 128
    AND length(validation_policy_id) BETWEEN 1 AND 128
    AND (tsa_policy_id IS NULL OR length(tsa_policy_id) BETWEEN 1 AND 128)
    AND length(provider_receipt_id) BETWEEN 1 AND 256
    AND length(validator_receipt_id) BETWEEN 1 AND 256
    AND length(validation_checks_json) BETWEEN 2 AND 32768
  ),
  CONSTRAINT pdf_seal_publish_command_bounds CHECK (
    source_byte_size BETWEEN 1 AND 33554432
    AND sealed_byte_size > source_byte_size AND sealed_byte_size <= 67108864
    AND validation_report_byte_size BETWEEN 1 AND 65536
  ),
  CONSTRAINT pdf_seal_publish_command_time_order CHECK (published_at >= validated_at)
);

-- Both rows are evidence, not mutable workflow state. Retrying publication
-- reads the command receipt and compares every field; allowing an UPDATE or
-- DELETE would make that replay proof forgeable after the fact.
CREATE FUNCTION reject_pdf_seal_publication_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pdf seal publication evidence is immutable';
END;
$$;

CREATE TRIGGER pdf_seal_publication_no_update_or_delete
BEFORE UPDATE OR DELETE ON pdf_seal_publication
FOR EACH ROW EXECUTE FUNCTION reject_pdf_seal_publication_mutation();

CREATE TRIGGER pdf_seal_publish_command_no_update_or_delete
BEFORE UPDATE OR DELETE ON pdf_seal_publish_command
FOR EACH ROW EXECUTE FUNCTION reject_pdf_seal_publication_mutation();
