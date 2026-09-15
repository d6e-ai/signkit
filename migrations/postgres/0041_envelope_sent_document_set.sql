-- PostgreSQL parity for migrations/d1/0045_envelope_sent_document_set.sql.
--
-- Per-document sent artifacts replace the single concatenated envelope_sent_pdf
-- pointer for newly sent envelopes. envelope_sent_pdf is kept: its rows are
-- frozen evidence for envelopes already sent, and recipients may be mid-signature
-- against them. envelope_send_command keeps the seven sent_pdf_* columns so a
-- pre-migration send receipt can still reconstruct its envelope.sent payload
-- byte-for-byte; new sends store document_set_hash, document_count, and
-- sent_documents_json instead.
--
-- Fields become document_id-scoped. document_path stays for legacy path-scoped
-- rows; exactly one of the two locators is set.
--
-- The N envelope_sent_document rows are pre-inserted before the publish marker;
-- the same transaction then inserts envelope_sent_document_set as the single
-- row whose existence means "this send is pinned".

CREATE TABLE envelope_sent_document (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  commit_sha text NOT NULL,
  document_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  kind text NOT NULL CHECK (kind IN ('markdown', 'pdf')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  object_key text NOT NULL,
  sha256 text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 25165824),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 400),
  page_width real NOT NULL CHECK (page_width > 0 AND page_width <= 20000),
  page_height real NOT NULL CHECK (page_height > 0 AND page_height <= 20000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, envelope_id, commit_sha, document_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CONSTRAINT envelope_sent_document_id_uuidv7 CHECK (
    document_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT envelope_sent_document_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT envelope_sent_document_position_unique UNIQUE (
    organization_id, envelope_id, commit_sha, position
  )
);

CREATE INDEX envelope_sent_document_object_key ON envelope_sent_document(object_key);

CREATE TABLE envelope_sent_document_set (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  commit_sha text NOT NULL,
  document_set_hash text NOT NULL,
  document_count integer NOT NULL CHECK (document_count BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, envelope_id, commit_sha),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  CONSTRAINT envelope_sent_document_set_hash_hex CHECK (document_set_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE envelope_field
  ADD COLUMN document_id text NULL,
  ALTER COLUMN document_path DROP NOT NULL,
  ADD CONSTRAINT envelope_field_document_id_uuidv7 CHECK (
    document_id IS NULL
    OR document_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  ADD CONSTRAINT envelope_field_document_scope CHECK (
    (document_id IS NULL) <> (document_path IS NULL)
  );

DROP INDEX envelope_field_document_order;
DROP INDEX envelope_field_recipient_document_position;

CREATE INDEX envelope_field_document_order
  ON envelope_field(organization_id, envelope_id, document_id, position, id)
  WHERE document_id IS NOT NULL;

CREATE INDEX envelope_field_document_path_order
  ON envelope_field(organization_id, envelope_id, document_path, position, id)
  WHERE document_path IS NOT NULL;

CREATE UNIQUE INDEX envelope_field_recipient_document_id_position
  ON envelope_field(organization_id, envelope_id, recipient_id, document_id, position)
  WHERE document_id IS NOT NULL;

CREATE UNIQUE INDEX envelope_field_recipient_document_path_position
  ON envelope_field(organization_id, envelope_id, recipient_id, document_path, position)
  WHERE document_path IS NOT NULL;

ALTER TABLE envelope_send_command
  DROP CONSTRAINT envelope_send_command_sent_pdf_complete,
  ADD COLUMN document_set_hash text NULL,
  ADD COLUMN document_count integer NULL,
  ADD COLUMN sent_documents_json text NULL,
  ADD CONSTRAINT envelope_send_command_sent_artifact_complete CHECK (
    (
      -- Pre-0039 rows: sent before either artifact shape existed, so every
      -- sent_pdf_* and document-set column defaulted to NULL when each was
      -- added. Genuine frozen evidence, not a partial write.
      sent_pdf_object_key IS NULL AND sent_pdf_sha256 IS NULL AND sent_pdf_bytes IS NULL
      AND sent_pdf_page_count IS NULL AND sent_pdf_page_width IS NULL
      AND sent_pdf_page_height IS NULL AND sent_pdf_document_pages_json IS NULL
      AND document_set_hash IS NULL AND document_count IS NULL AND sent_documents_json IS NULL
    )
    OR (
      sent_pdf_object_key IS NOT NULL AND sent_pdf_sha256 IS NOT NULL AND sent_pdf_bytes IS NOT NULL
      AND sent_pdf_page_count IS NOT NULL AND sent_pdf_page_width IS NOT NULL
      AND sent_pdf_page_height IS NOT NULL AND sent_pdf_document_pages_json IS NOT NULL
      AND document_set_hash IS NULL AND document_count IS NULL AND sent_documents_json IS NULL
    )
    OR (
      sent_pdf_object_key IS NULL AND sent_pdf_sha256 IS NULL AND sent_pdf_bytes IS NULL
      AND sent_pdf_page_count IS NULL AND sent_pdf_page_width IS NULL
      AND sent_pdf_page_height IS NULL AND sent_pdf_document_pages_json IS NULL
      AND document_set_hash IS NOT NULL AND document_count IS NOT NULL
      AND sent_documents_json IS NOT NULL
      AND document_count BETWEEN 1 AND 20
      AND document_set_hash ~ '^[0-9a-f]{64}$'
    )
  );
