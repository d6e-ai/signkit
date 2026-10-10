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
  job_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  validation_id TEXT NOT NULL,
  source_object_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_byte_size INTEGER NOT NULL,
  requested_profile TEXT NOT NULL CHECK (requested_profile IN ('pades-b-b','pades-b-t')),
  signer_certificate_sha256 TEXT NOT NULL,
  seal_policy_id TEXT NOT NULL,
  validation_policy_id TEXT NOT NULL,
  tsa_policy_id TEXT,
  tsa_trust_bundle_sha256 TEXT,
  provider_receipt_id TEXT NOT NULL,
  sealed_object_key TEXT NOT NULL,
  sealed_sha256 TEXT NOT NULL,
  sealed_byte_size INTEGER NOT NULL,
  achieved_profile TEXT NOT NULL CHECK (achieved_profile IN ('pades-b-b','pades-b-t')),
  validator_receipt_id TEXT NOT NULL,
  validation_checks_json TEXT NOT NULL,
  validation_report_object_key TEXT NOT NULL,
  validation_report_sha256 TEXT NOT NULL,
  validation_report_byte_size INTEGER NOT NULL,
  validated_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  anchor_audit_event_id TEXT NOT NULL,
  audit_head_sequence INTEGER NOT NULL CHECK (audit_head_sequence > 1),
  audit_head_event_hash TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  PRIMARY KEY (envelope_id),
  UNIQUE (job_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (job_id) REFERENCES pdf_seal_job(id),
  FOREIGN KEY (envelope_id) REFERENCES pdf_seal_job(envelope_id),
  FOREIGN KEY (anchor_audit_event_id) REFERENCES audit_event(id),
  CONSTRAINT pdf_seal_publication_digest_shapes CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(signer_certificate_sha256) = 64
    AND signer_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (tsa_trust_bundle_sha256 IS NULL OR
      (length(tsa_trust_bundle_sha256) = 64
       AND tsa_trust_bundle_sha256 NOT GLOB '*[^0-9a-f]*'))
    AND length(sealed_sha256) = 64 AND sealed_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(validation_report_sha256) = 64
    AND validation_report_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(audit_head_event_hash) = 64
    AND audit_head_event_hash NOT GLOB '*[^0-9a-f]*'
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
  job_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  validation_id TEXT NOT NULL,
  source_object_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_byte_size INTEGER NOT NULL,
  requested_profile TEXT NOT NULL CHECK (requested_profile IN ('pades-b-b','pades-b-t')),
  signer_certificate_sha256 TEXT NOT NULL,
  seal_policy_id TEXT NOT NULL,
  validation_policy_id TEXT NOT NULL,
  tsa_policy_id TEXT,
  tsa_trust_bundle_sha256 TEXT,
  provider_receipt_id TEXT NOT NULL,
  sealed_object_key TEXT NOT NULL,
  sealed_sha256 TEXT NOT NULL,
  sealed_byte_size INTEGER NOT NULL,
  achieved_profile TEXT NOT NULL CHECK (achieved_profile IN ('pades-b-b','pades-b-t')),
  validator_receipt_id TEXT NOT NULL,
  validation_checks_json TEXT NOT NULL,
  validation_report_object_key TEXT NOT NULL,
  validation_report_sha256 TEXT NOT NULL,
  validation_report_byte_size INTEGER NOT NULL,
  validated_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  anchor_audit_event_id TEXT NOT NULL,
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  audit_event_hash TEXT NOT NULL,
  audit_payload_json TEXT NOT NULL,
  PRIMARY KEY (job_id),
  UNIQUE (envelope_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (job_id) REFERENCES pdf_seal_job(id),
  FOREIGN KEY (envelope_id) REFERENCES pdf_seal_job(envelope_id),
  FOREIGN KEY (anchor_audit_event_id) REFERENCES audit_event(id),
  CONSTRAINT pdf_seal_publish_command_digest_shapes CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(signer_certificate_sha256) = 64
    AND signer_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (tsa_trust_bundle_sha256 IS NULL OR
      (length(tsa_trust_bundle_sha256) = 64
       AND tsa_trust_bundle_sha256 NOT GLOB '*[^0-9a-f]*'))
    AND length(sealed_sha256) = 64 AND sealed_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(validation_report_sha256) = 64
    AND validation_report_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(previous_audit_hash) = 64 AND previous_audit_hash NOT GLOB '*[^0-9a-f]*'
    AND length(audit_event_hash) = 64 AND audit_event_hash NOT GLOB '*[^0-9a-f]*'
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

-- The command insert is the sole D1 publication boundary. It rechecks the
-- job is still exactly `publication_ready`/`publish` with every frozen and
-- evidence field unchanged, that the envelope is still `completed` with an
-- unchanged source `completion_artifact_pdf` row, and that the supplied
-- audit anchor is still the current head, before publishing the immutable
-- pointer and appending the `envelope.pdf_seal_published` audit event. Any
-- failed predicate rolls this statement — including the command row itself
-- — back atomically. `pdf_seal_job` itself is never mutated here: the
-- public seal state is derived from `pdf_seal_publication`'s presence.
CREATE TRIGGER pdf_seal_publish_command_publish
AFTER INSERT ON pdf_seal_publish_command
BEGIN
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM pdf_seal_job
      WHERE id = NEW.job_id AND envelope_id = NEW.envelope_id
        AND operation_id = NEW.operation_id AND validation_id = NEW.validation_id
        AND status = 'publication_ready' AND next_action = 'publish'
        AND source_object_key = NEW.source_object_key AND source_sha256 = NEW.source_sha256
        AND source_byte_size = NEW.source_byte_size AND requested_profile = NEW.requested_profile
        AND signer_certificate_sha256 = NEW.signer_certificate_sha256
        AND seal_policy_id = NEW.seal_policy_id AND validation_policy_id = NEW.validation_policy_id
        AND tsa_policy_id IS NEW.tsa_policy_id
        AND tsa_trust_bundle_sha256 IS NEW.tsa_trust_bundle_sha256
        AND provider_receipt_id = NEW.provider_receipt_id
        AND sealed_object_key = NEW.sealed_object_key AND sealed_sha256 = NEW.sealed_sha256
        AND sealed_byte_size = NEW.sealed_byte_size AND achieved_profile = NEW.achieved_profile
        AND validator_receipt_id = NEW.validator_receipt_id
        AND validation_checks_json = NEW.validation_checks_json
        AND validation_report_object_key = NEW.validation_report_object_key
        AND validation_report_sha256 = NEW.validation_report_sha256
        AND validation_report_byte_size = NEW.validation_report_byte_size
        AND validated_at = NEW.validated_at
    ) THEN RAISE(ABORT, 'pdf seal publish job state conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM envelope WHERE id = NEW.envelope_id AND status = 'completed'
    ) THEN RAISE(ABORT, 'pdf seal publish envelope state conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM completion_artifact_pdf
      WHERE envelope_id = NEW.envelope_id AND pdf_object_key = NEW.source_object_key
        AND pdf_sha256 = NEW.source_sha256 AND pdf_byte_size = NEW.source_byte_size
    ) THEN RAISE(ABORT, 'pdf seal publish source conflict')
  END);

  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM audit_event previous
      WHERE previous.envelope_id = NEW.envelope_id
        AND previous.id = NEW.anchor_audit_event_id
        AND previous.sequence = NEW.audit_sequence - 1
        AND previous.event_hash = NEW.previous_audit_hash
    ) THEN RAISE(ABORT, 'pdf seal publish audit anchor conflict')
  END);

  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM audit_event newer
      WHERE newer.envelope_id = NEW.envelope_id AND newer.sequence >= NEW.audit_sequence
    ) THEN RAISE(ABORT, 'pdf seal publish audit head conflict')
  END);

  INSERT INTO pdf_seal_publication (
    job_id, envelope_id, operation_id, validation_id, source_object_key, source_sha256,
    source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id,
    validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id,
    sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile, validator_receipt_id,
    validation_checks_json, validation_report_object_key, validation_report_sha256,
    validation_report_byte_size, validated_at, published_at, anchor_audit_event_id,
    audit_head_sequence, audit_head_event_hash, audit_event_id
  ) VALUES (
    NEW.job_id, NEW.envelope_id, NEW.operation_id, NEW.validation_id, NEW.source_object_key,
    NEW.source_sha256, NEW.source_byte_size, NEW.requested_profile, NEW.signer_certificate_sha256,
    NEW.seal_policy_id, NEW.validation_policy_id, NEW.tsa_policy_id, NEW.tsa_trust_bundle_sha256,
    NEW.provider_receipt_id, NEW.sealed_object_key, NEW.sealed_sha256, NEW.sealed_byte_size,
    NEW.achieved_profile, NEW.validator_receipt_id, NEW.validation_checks_json,
    NEW.validation_report_object_key, NEW.validation_report_sha256, NEW.validation_report_byte_size,
    NEW.validated_at, NEW.published_at, NEW.anchor_audit_event_id, NEW.audit_sequence,
    NEW.audit_event_hash, NEW.audit_event_id
  );

  INSERT INTO audit_event (
    id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash,
    event_hash, occurred_at, hash_version
  ) VALUES (
    NEW.audit_event_id, NEW.envelope_id, NEW.audit_sequence, 'envelope.pdf_seal_published',
    'system', 'pdf-seal-worker', NEW.audit_payload_json, NEW.previous_audit_hash,
    NEW.audit_event_hash, NEW.published_at, 3
  );
END;

-- Publication rows and their replay receipts are append-only evidence. The
-- command trigger above is the only writer; retries only read and compare.
CREATE TRIGGER pdf_seal_publication_no_update
BEFORE UPDATE ON pdf_seal_publication
BEGIN
  SELECT RAISE(ABORT, 'pdf seal publication evidence is immutable');
END;

CREATE TRIGGER pdf_seal_publication_no_delete
BEFORE DELETE ON pdf_seal_publication
BEGIN
  SELECT RAISE(ABORT, 'pdf seal publication evidence is immutable');
END;

CREATE TRIGGER pdf_seal_publish_command_no_update
BEFORE UPDATE ON pdf_seal_publish_command
BEGIN
  SELECT RAISE(ABORT, 'pdf seal publication evidence is immutable');
END;

CREATE TRIGGER pdf_seal_publish_command_no_delete
BEFORE DELETE ON pdf_seal_publish_command
BEGIN
  SELECT RAISE(ABORT, 'pdf seal publication evidence is immutable');
END;
