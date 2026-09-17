-- Durable instance-invitation mail. Plaintext mailbox addresses and ski1_
-- bearer tokens are encrypted together before this row is written. The
-- purpose-separated AEAD binds ciphertext to invitation_id + delivery id.
CREATE TABLE instance_invitation_delivery_outbox (
  id TEXT NOT NULL PRIMARY KEY,
  invitation_id TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sealed_payload TEXT,
  sealing_key_id TEXT NOT NULL,
  sealed_payload_sha256 TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  retryable INTEGER NOT NULL DEFAULT 1,
  claim_token TEXT,
  locked_at TEXT,
  delivered_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (invitation_id) REFERENCES instance_invitation(id),
  CONSTRAINT instance_invitation_delivery_id_uuidv7 CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7' AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b') AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_delivery_locale_known CHECK (locale IN ('en', 'ja')),
  CONSTRAINT instance_invitation_delivery_status_known CHECK (
    status IN ('pending', 'processing', 'delivered', 'failed')
  ),
  CONSTRAINT instance_invitation_delivery_digest_sha256 CHECK (
    length(sealed_payload_sha256) = 64
    AND sealed_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_delivery_attempts_bound CHECK (attempts >= 0),
  CONSTRAINT instance_invitation_delivery_retryable_bool CHECK (retryable IN (0, 1)),
  CONSTRAINT instance_invitation_delivery_claim_state CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CONSTRAINT instance_invitation_delivery_terminal_state CHECK (
    (status = 'delivered' AND retryable = 0 AND sealed_payload IS NULL
      AND delivered_at IS NOT NULL AND provider_message_id IS NOT NULL AND last_error IS NULL)
    OR (status = 'failed' AND retryable = 0 AND sealed_payload IS NULL
      AND delivered_at IS NULL AND provider_message_id IS NULL AND last_error IS NOT NULL)
    OR (status IN ('pending', 'processing', 'failed') AND retryable = 1
      AND sealed_payload IS NOT NULL AND delivered_at IS NULL AND provider_message_id IS NULL)
  )
);

CREATE INDEX instance_invitation_delivery_claim
  ON instance_invitation_delivery_outbox(status, retryable, available_at, created_at, id);
CREATE INDEX instance_invitation_delivery_reclaim
  ON instance_invitation_delivery_outbox(status, locked_at, created_at, id);

-- Acceptance and revocation immediately destroy reusable token ciphertext.
CREATE TRIGGER instance_invitation_delivery_terminal_scrub
AFTER UPDATE OF status ON instance_invitation
WHEN NEW.status IN ('accepted', 'revoked') AND OLD.status = 'pending'
BEGIN
  UPDATE instance_invitation_delivery_outbox
  SET status = 'failed', retryable = 0, sealed_payload = NULL,
      claim_token = NULL, locked_at = NULL, last_error = 'invitation_not_active',
      available_at = COALESCE(NEW.accepted_at, NEW.revoked_at),
      updated_at = COALESCE(NEW.accepted_at, NEW.revoked_at)
  WHERE invitation_id = NEW.id AND status <> 'delivered';
END;
