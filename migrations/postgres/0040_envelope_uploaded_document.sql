-- PostgreSQL parity for migrations/d1/0044_envelope_uploaded_document.sql.
--
-- Append-only ledger of every uploaded PDF digest an envelope has pinned.
-- Git stores only a text manifest; the bytes live in object storage. The
-- orphan sweep resolves live references from SQL, so a digest that exists
-- solely inside a Git archive would be collected after the grace period.
-- This table is that SQL reference: every digest this envelope ever uploaded
-- stays live, even if a later replace-commit no longer points at it.
CREATE TABLE envelope_uploaded_document (
  envelope_id text NOT NULL,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 400),
  page_width real NOT NULL CHECK (page_width > 0 AND page_width <= 20000),
  page_height real NOT NULL CHECK (page_height > 0 AND page_height <= 20000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (envelope_id, sha256),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CONSTRAINT envelope_uploaded_document_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX envelope_uploaded_document_object_key ON envelope_uploaded_document(object_key);
