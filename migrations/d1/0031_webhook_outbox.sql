CREATE TABLE webhook_outbox (
  organization_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  claim_token TEXT,
  locked_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, endpoint_id, audit_event_id),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES webhook_endpoint(organization_id, id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES audit_event(organization_id, id),
  CONSTRAINT webhook_outbox_status_known CHECK (
    status IN ('pending', 'processing', 'delivered', 'failed')
  ),
  CONSTRAINT webhook_outbox_payload_bound CHECK (length(payload_json) BETWEEN 2 AND 32768)
);

CREATE INDEX webhook_outbox_claim
  ON webhook_outbox(status, available_at, endpoint_id);
