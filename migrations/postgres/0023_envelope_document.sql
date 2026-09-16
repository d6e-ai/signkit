-- Stable per-envelope document metadata (title, ordering) keyed by the
-- Markdown path tracked in the envelope's Git repository. Git remains the
-- content boundary; this table owns only display metadata that survives
-- across draft commits, mirroring how `recipient` and `envelope_field` own
-- SQL-only metadata alongside the same repository.
CREATE TABLE envelope_document (
  id text NOT NULL,
  envelope_id text NOT NULL,
  markdown_path text NOT NULL,
  title text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CONSTRAINT envelope_document_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT envelope_document_path_shape CHECK (
    markdown_path ~ '^documents/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$'
  )
);

CREATE UNIQUE INDEX envelope_document_path
  ON envelope_document(envelope_id, markdown_path);

CREATE UNIQUE INDEX envelope_document_position
  ON envelope_document(envelope_id, position);
