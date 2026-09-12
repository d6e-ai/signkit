-- Completion artifact delivery outbox and access grant table.
-- Distinct from signing delivery outbox: targets only completed envelopes with
-- published completion artifacts, issues purpose-bound 32-byte skca1_ access
-- tokens for signers, approvers, viewers, and CC recipients (excluding prefill),
-- enforces a 30-day access expiry, and maintains durable grant status alongside
-- delivery progress.
CREATE TABLE completion_delivery_outbox (
  id text NOT NULL,
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  token_hash text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  access_revoked_at timestamptz,
  sealed_token text,
  sealing_key_id text NOT NULL,
  sealed_token_sha256 text NOT NULL,
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at timestamptz,
  claim_token text,
  delivered_at timestamptz,
  provider_message_id text,
  last_error text,
  retryable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, recipient_id),
  FOREIGN KEY (organization_id, envelope_id)
    REFERENCES completion_artifact(organization_id, envelope_id),
  CONSTRAINT completion_delivery_recipient_scope
    FOREIGN KEY (organization_id, envelope_id, recipient_id)
    REFERENCES recipient(organization_id, envelope_id, id),
  CONSTRAINT completion_delivery_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  -- A claim token is opaque lease material, not a row identifier, so it keeps
  -- its length-only bound.
  CONSTRAINT completion_delivery_claim_token_length CHECK (
    claim_token IS NULL OR length(claim_token) BETWEEN 16 AND 200
  ),
  CONSTRAINT completion_delivery_claim_state CHECK (
    (status = 'processing' AND claim_token IS NOT NULL AND locked_at IS NOT NULL) OR
    (status <> 'processing' AND claim_token IS NULL AND locked_at IS NULL)
  ),
  CONSTRAINT completion_delivery_terminal_state CHECK (
    (status IN ('pending', 'processing') AND retryable AND access_revoked_at IS NULL) OR
    (status = 'delivered' AND NOT retryable AND sealed_token IS NULL) OR
    (status = 'failed' AND (
      (retryable AND access_revoked_at IS NULL) OR
      (NOT retryable AND sealed_token IS NULL AND access_revoked_at IS NOT NULL)
    ))
  )
);

CREATE UNIQUE INDEX completion_delivery_outbox_token_hash
  ON completion_delivery_outbox(token_hash);

CREATE INDEX completion_delivery_outbox_claim
  ON completion_delivery_outbox(status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX completion_delivery_outbox_reclaim
  ON completion_delivery_outbox(locked_at, created_at)
  WHERE status = 'processing';

CREATE INDEX completion_delivery_outbox_terminal_cleanup
  ON completion_delivery_outbox(status, updated_at, created_at)
  WHERE retryable AND sealed_token IS NOT NULL;
