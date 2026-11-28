-- Optional signer-only typed-signature suggestion entered by the sender at
-- ready time. Display text only: email and name remain the delivery, identity,
-- and audit values. Existing rows keep NULL; no prior evidence is rewritten.
ALTER TABLE recipient ADD COLUMN signature_display_name TEXT
  CONSTRAINT recipient_signature_display_name_valid CHECK (
    signature_display_name IS NULL
    OR (
      length(signature_display_name) BETWEEN 1 AND 200
      AND signature_display_name = trim(signature_display_name)
      AND role = 'signer'
    )
  );
