-- Stable per-envelope document metadata (title, ordering) keyed by the
-- Markdown path tracked in the envelope's Git repository. Git remains the
-- content boundary; this table owns only display metadata that survives
-- across draft commits, mirroring how `recipient` and `envelope_field` own
-- SQL-only metadata alongside the same repository.
CREATE TABLE envelope_document (
  id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 100000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  CONSTRAINT envelope_document_id_uuidv7 CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT envelope_document_path_shape CHECK (
    markdown_path GLOB 'documents/[a-zA-Z0-9]*.md'
  )
);

CREATE UNIQUE INDEX envelope_document_path
  ON envelope_document(envelope_id, markdown_path);

CREATE UNIQUE INDEX envelope_document_position
  ON envelope_document(envelope_id, position);
