-- Completion artifact publication is a durable reconciliation job, not an
-- extension of the hot recipient sign/approve completion transactions. A
-- periodic worker discovers `completed` envelopes lacking a published
-- artifact (including envelopes that completed before this migration),
-- leases one job per envelope, and publishes exactly one immutable pointer
-- plus one chained `envelope.completion_artifact_published` audit event.
CREATE TABLE completion_artifact_job (
  envelope_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','published','failed')),
  claim_token text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  retryable boolean NOT NULL DEFAULT true,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (envelope_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL) OR
    (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CHECK (status <> 'published' OR NOT retryable)
);

CREATE INDEX completion_artifact_job_claim
  ON completion_artifact_job(status, available_at)
  WHERE status IN ('pending','failed');

CREATE INDEX completion_artifact_job_reclaim
  ON completion_artifact_job(locked_at)
  WHERE status = 'processing';

-- The published pointer. One row per envelope, ever: object bytes are
-- content-addressed and immutable, and this row is the sole SQL boundary
-- that makes a specific pair of them the envelope's completion evidence.
CREATE TABLE completion_artifact (
  envelope_id text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  manifest_sha256 text NOT NULL,
  json_object_key text NOT NULL,
  json_sha256 text NOT NULL,
  markdown_object_key text NOT NULL,
  markdown_sha256 text NOT NULL,
  sent_commit_sha text NOT NULL,
  field_generation integer NOT NULL,
  anchor_audit_event_id text NOT NULL,
  audit_head_sequence bigint NOT NULL,
  audit_head_event_hash text NOT NULL,
  published_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  PRIMARY KEY (envelope_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (anchor_audit_event_id) REFERENCES audit_event(id)
);

-- PostgreSQL has no D1-style rollback-on-failed-predicate trigger; the
-- adapter locks the envelope row then this job row in that order inside one
-- transaction, rechecks the same predicates in application code, and inserts
-- the pointer, job update, and audit event together before committing.
CREATE TABLE completion_artifact_publish_command (
  envelope_id text NOT NULL,
  claim_token text NOT NULL,
  sent_commit_sha text NOT NULL,
  field_generation integer NOT NULL,
  anchor_audit_event_id text NOT NULL,
  manifest_sha256 text NOT NULL,
  json_object_key text NOT NULL,
  json_sha256 text NOT NULL,
  markdown_object_key text NOT NULL,
  markdown_sha256 text NOT NULL,
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (envelope_id),
  UNIQUE (audit_event_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (anchor_audit_event_id) REFERENCES audit_event(id)
);
