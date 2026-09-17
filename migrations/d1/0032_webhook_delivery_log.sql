CREATE TABLE webhook_delivery_log (
  id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (endpoint_id, audit_event_id)
    REFERENCES webhook_outbox(endpoint_id, audit_event_id),
  CONSTRAINT webhook_delivery_log_status_known CHECK (
    status IN ('delivered', 'failed', 'retrying')
  )
);

CREATE INDEX webhook_delivery_log_endpoint
  ON webhook_delivery_log(endpoint_id, occurred_at DESC, id DESC);
