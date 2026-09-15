-- Append-only ledger of every uploaded PDF digest an envelope has pinned.
-- Git stores only a text manifest; the bytes live in object storage. The
-- orphan sweep resolves live references from SQL, so a digest that exists
-- solely inside a Git archive would be collected after the grace period.
-- This table is that SQL reference: every digest this envelope ever uploaded
-- stays live, even if a later replace-commit no longer points at it.
CREATE TABLE envelope_uploaded_document (
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 400),
  page_width REAL NOT NULL CHECK (page_width > 0 AND page_width <= 20000),
  page_height REAL NOT NULL CHECK (page_height > 0 AND page_height <= 20000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, envelope_id, sha256),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CONSTRAINT envelope_uploaded_document_sha256_hex CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX envelope_uploaded_document_object_key ON envelope_uploaded_document(object_key);
