-- The deterministic, immutable final PDF rendering of a published completion
-- artifact. Separated from `completion_artifact` (Slice A) rather than an
-- ALTER, mirroring the existing "durable reconciliation, decoupled from the
-- hot path" philosophy: PDF rendering is a pure function of already-verified
-- evidence and can be generated, retried, or backfilled independently of the
-- JSON/Markdown manifest publication it depends on. No trigger is needed
-- here (unlike completion_artifact_publish_command): the row is
-- content-addressed and derived, so a plain insert-if-absent is sufficient.
CREATE TABLE completion_artifact_pdf (
  envelope_id TEXT NOT NULL,
  pdf_object_key TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL,
  pdf_manifest_object_key TEXT NOT NULL,
  pdf_manifest_sha256 TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (envelope_id),
  FOREIGN KEY (envelope_id)
    REFERENCES completion_artifact(envelope_id)
);
