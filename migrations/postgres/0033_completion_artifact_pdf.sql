-- The deterministic, immutable final PDF rendering of a published completion
-- artifact. Separated from `completion_artifact` (Slice A) rather than an
-- ALTER, mirroring the existing "durable reconciliation, decoupled from the
-- hot path" philosophy: PDF rendering is a pure function of already-verified
-- evidence and can be generated, retried, or backfilled independently of the
-- JSON/Markdown manifest publication it depends on.
CREATE TABLE completion_artifact_pdf (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  pdf_object_key text NOT NULL,
  pdf_sha256 text NOT NULL,
  pdf_manifest_object_key text NOT NULL,
  pdf_manifest_sha256 text NOT NULL,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, envelope_id),
  FOREIGN KEY (organization_id, envelope_id)
    REFERENCES completion_artifact(organization_id, envelope_id)
);
