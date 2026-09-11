ALTER TABLE delivery_outbox
  ADD COLUMN claim_token TEXT CHECK (
    claim_token IS NULL OR length(claim_token) BETWEEN 16 AND 200
  );

ALTER TABLE delivery_outbox
  ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1));

UPDATE delivery_outbox
SET status = 'failed',
    locked_at = NULL,
    available_at = COALESCE(available_at, updated_at),
    last_error = 'worker_restarted',
    retryable = 1
WHERE status = 'processing';

CREATE INDEX delivery_outbox_reclaim
  ON delivery_outbox(locked_at, created_at)
  WHERE status = 'processing';

CREATE INDEX delivery_outbox_terminal_cleanup
  ON delivery_outbox(status, updated_at, created_at)
  WHERE retryable = 1 AND sealed_capability IS NOT NULL;

CREATE TRIGGER delivery_outbox_claim_insert_guard
BEFORE INSERT ON delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery claim state');
END;

CREATE TRIGGER delivery_outbox_claim_state_guard
BEFORE UPDATE OF status, claim_token, locked_at ON delivery_outbox
WHEN (
  NEW.status = 'processing'
  AND (NEW.claim_token IS NULL OR NEW.locked_at IS NULL)
) OR (
  NEW.status <> 'processing'
  AND (NEW.claim_token IS NOT NULL OR NEW.locked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery claim state');
END;

CREATE TRIGGER delivery_outbox_terminal_insert_guard
BEFORE INSERT ON delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND NEW.retryable <> 1
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_capability IS NOT NULL)
) OR (
  NEW.retryable = 0
  AND (NEW.status NOT IN ('failed', 'delivered') OR NEW.sealed_capability IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery terminal state');
END;

CREATE TRIGGER delivery_outbox_terminal_state_guard
BEFORE UPDATE OF status, sealed_capability, retryable ON delivery_outbox
WHEN (
  NEW.status IN ('pending', 'processing')
  AND NEW.retryable <> 1
) OR (
  NEW.status = 'delivered'
  AND (NEW.retryable <> 0 OR NEW.sealed_capability IS NOT NULL)
) OR (
  NEW.retryable = 0
  AND (NEW.status NOT IN ('failed', 'delivered') OR NEW.sealed_capability IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery terminal state');
END;
