-- Envelope-scoped field reads (detail SELECT and authoring LEFT JOIN) filter by
-- envelope_id and order by COALESCE(document_id, document_path), position, id
-- across both PDF and Markdown locators. The 0045 partial document_id /
-- document_path indexes cannot serve that envelope-wide predicate. Forward-only;
-- existing document indexes stay.

CREATE INDEX envelope_field_envelope_coalesce_order
  ON envelope_field(envelope_id, COALESCE(document_id, document_path), position, id);
