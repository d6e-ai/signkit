-- Atomic optional PDF metadata on the existing publication receipt, plus a
-- dedicated repair job for already-published envelopes whose PDF pointer never
-- landed. Repair never rewrites the manifest, publication audit, or primary job.
ALTER TABLE completion_artifact_publish_command
  ADD COLUMN pdf_object_key text,
  ADD COLUMN pdf_sha256 text,
  ADD COLUMN pdf_byte_size integer,
  ADD COLUMN pdf_manifest_object_key text,
  ADD COLUMN pdf_manifest_sha256 text;

ALTER TABLE completion_artifact_publish_command
  ADD CONSTRAINT completion_artifact_publish_command_pdf_all_or_none CHECK (
    (
      pdf_object_key IS NULL
      AND pdf_sha256 IS NULL
      AND pdf_byte_size IS NULL
      AND pdf_manifest_object_key IS NULL
      AND pdf_manifest_sha256 IS NULL
    )
    OR (
      pdf_object_key IS NOT NULL
      AND pdf_sha256 IS NOT NULL
      AND pdf_byte_size BETWEEN 1 AND 33554432
      AND pdf_manifest_object_key IS NOT NULL
      AND pdf_manifest_sha256 IS NOT NULL
    )
  );

CREATE TABLE completion_artifact_pdf_repair (
  envelope_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','repaired','failed')),
  claim_token text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  retryable boolean NOT NULL DEFAULT true,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (envelope_id),
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact(envelope_id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL) OR
    (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CHECK (status <> 'repaired' OR NOT retryable)
);

CREATE INDEX completion_artifact_pdf_repair_claim
  ON completion_artifact_pdf_repair(status, available_at)
  WHERE status IN ('pending','failed');

CREATE INDEX completion_artifact_pdf_repair_reclaim
  ON completion_artifact_pdf_repair(locked_at)
  WHERE status = 'processing';

CREATE TABLE completion_artifact_pdf_repair_command (
  envelope_id text NOT NULL,
  claim_token text NOT NULL,
  expected_manifest_sha256 text NOT NULL,
  pdf_object_key text NOT NULL,
  pdf_sha256 text NOT NULL,
  pdf_byte_size integer NOT NULL CHECK (pdf_byte_size BETWEEN 1 AND 33554432),
  pdf_manifest_object_key text NOT NULL,
  pdf_manifest_sha256 text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (envelope_id),
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact(envelope_id)
);

-- Operator requeue receipts. `expected_failed_at` is the exact `updated_at`
-- the exhausting failure wrote: attempts alone repeat after a requeue
-- (10 -> 0 -> 10), so the failure timestamp is the generation CAS that keeps a
-- stale or duplicate command from resetting a newer job.
CREATE TABLE completion_artifact_retry_command (
  envelope_id text NOT NULL,
  idempotency_key text NOT NULL,
  expected_attempts integer NOT NULL CHECK (expected_attempts >= 0),
  expected_failed_at timestamptz NOT NULL,
  requeued_at timestamptz NOT NULL,
  PRIMARY KEY (envelope_id, idempotency_key),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id)
);

CREATE TABLE completion_artifact_pdf_repair_retry_command (
  envelope_id text NOT NULL,
  idempotency_key text NOT NULL,
  expected_attempts integer NOT NULL CHECK (expected_attempts >= 0),
  expected_failed_at timestamptz NOT NULL,
  requeued_at timestamptz NOT NULL,
  PRIMARY KEY (envelope_id, idempotency_key),
  FOREIGN KEY (envelope_id) REFERENCES completion_artifact_pdf_repair(envelope_id)
);
