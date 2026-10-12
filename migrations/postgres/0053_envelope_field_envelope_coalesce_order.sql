-- PostgreSQL parity for migrations/d1/0057_envelope_field_envelope_coalesce_order.sql.
--
-- envelope_field.document_id is text (0041), the same type as document_path, so
-- COALESCE(document_id, document_path) matches the live detail and authoring
-- ORDER BY expressions without a document_id::text cast. No earlier migration
-- created an envelope-leading COALESCE index; the 0041 partial document indexes
-- remain.

CREATE INDEX envelope_field_envelope_coalesce_order
  ON envelope_field (envelope_id, (COALESCE(document_id, document_path)), position, id);
