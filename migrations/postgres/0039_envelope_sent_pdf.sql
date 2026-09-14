-- PostgreSQL parity for migrations/d1/0043_envelope_sent_pdf.sql.
--
-- The exact, immutable PDF rendering of the revision an envelope was sent at.
-- The Git archive remains the source of truth for history; this is the
-- artifact a recipient is actually shown, and the only surface a signing
-- field's page/x/y geometry can be pinned against.
--
-- The pointer is integrity-pinned three ways -- content-addressed object key,
-- SHA-256, and byte size -- and scoped to (organization, envelope, commit), so
-- a pointer published for one revision can never satisfy a read pinned to
-- another.
--
-- The D1 profile publishes this row from inside the send-publish trigger
-- because that trigger is where its atomicity lives. PostgreSQL publishes it
-- from inside the same `BEGIN` block as the status flip and the audit event
-- in PostgresEnvelopeSendStore, which is the equivalent boundary: a stale
-- generation, a lost CAS, an audit conflict, or an idempotency conflict rolls
-- all three back together. The column-level guard below is the durable half
-- of that promise -- a send command row either carries a complete pointer or
-- none at all, and the application refuses to publish the latter.
ALTER TABLE envelope_send_command
  ADD COLUMN sent_pdf_object_key text NULL,
  ADD COLUMN sent_pdf_sha256 text NULL,
  ADD COLUMN sent_pdf_bytes bigint NULL,
  ADD COLUMN sent_pdf_page_count integer NULL,
  ADD COLUMN sent_pdf_page_width real NULL,
  ADD COLUMN sent_pdf_page_height real NULL,
  ADD COLUMN sent_pdf_document_pages_json text NULL,
  ADD CONSTRAINT envelope_send_command_sent_pdf_complete CHECK (
    (sent_pdf_object_key IS NULL AND sent_pdf_sha256 IS NULL AND sent_pdf_bytes IS NULL
      AND sent_pdf_page_count IS NULL AND sent_pdf_page_width IS NULL
      AND sent_pdf_page_height IS NULL AND sent_pdf_document_pages_json IS NULL)
    OR (sent_pdf_object_key IS NOT NULL AND sent_pdf_sha256 IS NOT NULL AND sent_pdf_bytes IS NOT NULL
      AND sent_pdf_page_count IS NOT NULL AND sent_pdf_page_width IS NOT NULL
      AND sent_pdf_page_height IS NOT NULL AND sent_pdf_document_pages_json IS NOT NULL)
  );

CREATE TABLE envelope_sent_pdf (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  commit_sha text NOT NULL,
  object_key text NOT NULL,
  sha256 text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 25165824),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 400),
  page_width real NOT NULL CHECK (page_width > 0 AND page_width <= 20000),
  page_height real NOT NULL CHECK (page_height > 0 AND page_height <= 20000),
  document_pages_json text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, envelope_id, commit_sha),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CONSTRAINT envelope_sent_pdf_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX envelope_sent_pdf_object_key ON envelope_sent_pdf(object_key);
