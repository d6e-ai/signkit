-- PostgreSQL parity for migrations/d1/0062_recipient_signature_display_name.sql.
-- Optional signer-only typed-signature suggestion entered by the sender at
-- ready time. Display text only: email and name remain the delivery, identity,
-- and audit values. Existing rows keep NULL; no prior evidence is rewritten.
ALTER TABLE recipient ADD COLUMN signature_display_name text;

ALTER TABLE recipient ADD CONSTRAINT recipient_signature_display_name_valid CHECK (
  signature_display_name IS NULL
  OR (
    char_length(signature_display_name) BETWEEN 1 AND 200
    AND signature_display_name = btrim(signature_display_name)
    AND role = 'signer'
  )
);
