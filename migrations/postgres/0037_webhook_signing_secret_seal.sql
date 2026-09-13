-- Seal webhook HMAC signing secrets at rest (skwhs1_ + AAD). Null
-- sealing_key_id is the dual-read path for legacy plaintext skwh1_ rows;
-- drain reseals those onto the active DELIVERY_ENCRYPTION_KEY.
ALTER TABLE webhook_endpoint
  ADD COLUMN sealing_key_id text
  CONSTRAINT webhook_endpoint_sealing_key_id_hex CHECK (
    sealing_key_id IS NULL OR sealing_key_id ~ '^[0-9a-f]{16}$'
  );

ALTER TABLE webhook_endpoint
  DROP CONSTRAINT webhook_endpoint_signing_secret_bound;

-- Plaintext skwh1_ secrets are ~49 characters; sealed skwhs1_ blobs are ~110.
ALTER TABLE webhook_endpoint
  ADD CONSTRAINT webhook_endpoint_signing_secret_bound CHECK (
    char_length(signing_secret) BETWEEN 20 AND 200
  );
