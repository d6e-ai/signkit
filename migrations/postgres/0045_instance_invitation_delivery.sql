-- Durable instance-invitation mail. Plaintext mailbox addresses and ski1_
-- bearer tokens are encrypted together before this row is written. The
-- purpose-separated AEAD binds ciphertext to invitation_id + delivery id.
CREATE TABLE instance_invitation_delivery_outbox (
  id text NOT NULL PRIMARY KEY,
  invitation_id text NOT NULL UNIQUE REFERENCES instance_invitation(id),
  locale text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  sealed_payload text,
  sealing_key_id text NOT NULL,
  sealed_payload_sha256 text NOT NULL,
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  retryable boolean NOT NULL DEFAULT true,
  claim_token text,
  locked_at timestamptz,
  delivered_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT instance_invitation_delivery_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT instance_invitation_delivery_locale_known CHECK (locale IN ('en', 'ja')),
  CONSTRAINT instance_invitation_delivery_status_known CHECK (
    status IN ('pending', 'processing', 'delivered', 'failed')
  ),
  CONSTRAINT instance_invitation_delivery_digest_sha256 CHECK (
    sealed_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT instance_invitation_delivery_attempts_bound CHECK (attempts >= 0),
  CONSTRAINT instance_invitation_delivery_claim_state CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CONSTRAINT instance_invitation_delivery_terminal_state CHECK (
    (status = 'delivered' AND NOT retryable AND sealed_payload IS NULL
      AND delivered_at IS NOT NULL AND provider_message_id IS NOT NULL AND last_error IS NULL)
    OR (status = 'failed' AND NOT retryable AND sealed_payload IS NULL
      AND delivered_at IS NULL AND provider_message_id IS NULL AND last_error IS NOT NULL)
    OR (status IN ('pending', 'processing', 'failed') AND retryable
      AND sealed_payload IS NOT NULL AND delivered_at IS NULL AND provider_message_id IS NULL)
  )
);

CREATE INDEX instance_invitation_delivery_claim
  ON instance_invitation_delivery_outbox(status, retryable, available_at, created_at, id);
CREATE INDEX instance_invitation_delivery_reclaim
  ON instance_invitation_delivery_outbox(status, locked_at, created_at, id);

CREATE OR REPLACE FUNCTION scrub_terminal_instance_invitation_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('accepted', 'revoked') AND OLD.status = 'pending' THEN
    UPDATE instance_invitation_delivery_outbox
    SET status = 'failed', retryable = false, sealed_payload = NULL,
        claim_token = NULL, locked_at = NULL, last_error = 'invitation_not_active',
        available_at = COALESCE(NEW.accepted_at, NEW.revoked_at),
        updated_at = COALESCE(NEW.accepted_at, NEW.revoked_at)
    WHERE invitation_id = NEW.id AND status <> 'delivered';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instance_invitation_delivery_terminal_scrub
AFTER UPDATE OF status ON instance_invitation
FOR EACH ROW EXECUTE FUNCTION scrub_terminal_instance_invitation_delivery();
