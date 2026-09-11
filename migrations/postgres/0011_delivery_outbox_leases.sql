ALTER TABLE delivery_outbox
  ADD COLUMN claim_token text,
  ADD COLUMN retryable boolean NOT NULL DEFAULT true;

UPDATE delivery_outbox
SET status = 'failed',
    locked_at = NULL,
    available_at = COALESCE(available_at, updated_at),
    last_error = 'worker_restarted',
    retryable = true
WHERE status = 'processing';

ALTER TABLE delivery_outbox
  ADD CONSTRAINT delivery_outbox_claim_token_length CHECK (
    claim_token IS NULL OR length(claim_token) BETWEEN 16 AND 200
  ),
  ADD CONSTRAINT delivery_outbox_claim_state CHECK (
    (
      status = 'processing'
      AND claim_token IS NOT NULL
      AND locked_at IS NOT NULL
      AND retryable
    ) OR (
      status <> 'processing'
      AND claim_token IS NULL
      AND locked_at IS NULL
    )
  ),
  ADD CONSTRAINT delivery_outbox_terminal_state CHECK (
    (status <> 'delivered' OR (NOT retryable AND sealed_capability IS NULL))
    AND (
      retryable
      OR (status IN ('failed', 'delivered') AND sealed_capability IS NULL)
    )
  ),
  ADD CONSTRAINT delivery_outbox_pending_retryable CHECK (
    status <> 'pending' OR retryable
  );

CREATE INDEX delivery_outbox_reclaim
  ON delivery_outbox(locked_at, created_at)
  WHERE status = 'processing';

CREATE INDEX delivery_outbox_terminal_cleanup
  ON delivery_outbox(status, updated_at, created_at)
  WHERE retryable AND sealed_capability IS NOT NULL;
