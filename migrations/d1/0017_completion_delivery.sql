-- Completion artifact delivery outbox and access grant table.
-- Distinct from signing delivery outbox: targets only completed envelopes with
-- published completion artifacts, issues purpose-bound 32-byte skca1_ access
-- tokens for signers, approvers, viewers, and CC recipients (excluding prefill),
-- enforces a 30-day access expiry, and maintains durable grant status alongside
-- delivery progress.
CREATE TABLE completion_delivery_outbox (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  token_hash TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  access_revoked_at TEXT,
  sealed_token TEXT,
  sealing_key_id TEXT NOT NULL,
  sealed_token_sha256 TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TEXT,
  claim_token TEXT CHECK (
    claim_token IS NULL OR length(claim_token) BETWEEN 16 AND 200
  ),
  delivered_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, envelope_id, recipient_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES completion_artifact(organization_id, envelope_id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id)
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
  WHERE retryable = 1 AND sealed_token IS NOT NULL;

CREATE TRIGGER completion_delivery_outbox_claim_insert_guard
BEFORE INSERT ON completion_delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery claim state');
END;

CREATE TRIGGER completion_delivery_outbox_claim_state_guard
BEFORE UPDATE OF status, claim_token, locked_at ON completion_delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery claim state');
END;

CREATE TRIGGER completion_delivery_outbox_terminal_insert_guard
BEFORE INSERT ON completion_delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND (NEW.retryable <> 1 OR NEW.access_revoked_at IS NOT NULL)
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_token IS NOT NULL)
) OR (
  NEW.status = 'failed'
  AND (
    (NEW.retryable = 1 AND NEW.access_revoked_at IS NOT NULL) OR
    (NEW.retryable = 0 AND (NEW.sealed_token IS NOT NULL OR NEW.access_revoked_at IS NULL))
  )
) OR (
  NEW.retryable = 0
  AND NEW.status NOT IN ('failed', 'delivered')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery terminal state');
END;

CREATE TRIGGER completion_delivery_outbox_terminal_state_guard
BEFORE UPDATE OF status, sealed_token, retryable, access_revoked_at ON completion_delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND (NEW.retryable <> 1 OR NEW.access_revoked_at IS NOT NULL)
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_token IS NOT NULL)
) OR (
  NEW.status = 'failed'
  AND (
    (NEW.retryable = 1 AND NEW.access_revoked_at IS NOT NULL) OR
    (NEW.retryable = 0 AND (NEW.sealed_token IS NOT NULL OR NEW.access_revoked_at IS NULL))
  )
) OR (
  NEW.retryable = 0
  AND NEW.status NOT IN ('failed', 'delivered')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery terminal state');
END;

CREATE TRIGGER completion_delivery_outbox_recipient_scope_insert_guard
BEFORE INSERT ON completion_delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.organization_id = NEW.organization_id
    AND target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
    AND target.role IN ('signer', 'approver', 'viewer', 'cc')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery recipient scope');
END;

CREATE TRIGGER completion_delivery_outbox_recipient_scope_update_guard
BEFORE UPDATE OF organization_id, envelope_id, recipient_id ON completion_delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.organization_id = NEW.organization_id
    AND target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
    AND target.role IN ('signer', 'approver', 'viewer', 'cc')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion delivery recipient scope');
END;
