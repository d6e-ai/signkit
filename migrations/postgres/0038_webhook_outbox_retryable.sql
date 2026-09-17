-- Durable terminal vs retryable webhook failures. Non-retryable rows stay
-- failed and are never reclaimed; retryable rows keep the existing attempt
-- ceiling. Latest delivery_log status 'failed' is the backfill signal for
-- already-terminal rows (HTTP 4xx / SSRF / payload-too-large / exhausted).
ALTER TABLE webhook_outbox
  ADD COLUMN retryable boolean NOT NULL DEFAULT true;

UPDATE webhook_outbox
SET retryable = false
WHERE status = 'failed'
  AND (
    SELECT log.status
    FROM webhook_delivery_log AS log
    WHERE log.endpoint_id = webhook_outbox.endpoint_id
      AND log.audit_event_id = webhook_outbox.audit_event_id
    ORDER BY log.occurred_at DESC, log.id DESC
    LIMIT 1
  ) = 'failed';
