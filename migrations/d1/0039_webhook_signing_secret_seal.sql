-- Seal webhook HMAC signing secrets at rest (skwhs1_ + AAD). Null
-- sealing_key_id is the dual-read path for legacy plaintext skwh1_ rows;
-- drain reseals those onto the active DELIVERY_ENCRYPTION_KEY.
ALTER TABLE webhook_endpoint
  ADD COLUMN sealing_key_id TEXT
  CHECK (
    sealing_key_id IS NULL
    OR (
      length(sealing_key_id) = 16
      -- Short negated class only: a per-character GLOB would exceed the
      -- Cloudflare D1 LIKE/GLOB pattern complexity cap.
      AND sealing_key_id NOT GLOB '*[^0-9a-f]*'
    )
  );
