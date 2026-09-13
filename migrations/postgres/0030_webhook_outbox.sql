CREATE TABLE webhook_outbox (
  organization_id text NOT NULL,
  endpoint_id text NOT NULL,
  audit_event_id text NOT NULL,
  envelope_id text NOT NULL,
  event_type text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  claim_token text,
  locked_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, endpoint_id, audit_event_id),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES webhook_endpoint(organization_id, id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES audit_event(organization_id, id),
  CONSTRAINT webhook_outbox_status_known CHECK (
    status IN ('pending', 'processing', 'delivered', 'failed')
  ),
  CONSTRAINT webhook_outbox_payload_bound CHECK (char_length(payload_json) BETWEEN 2 AND 32768),
  CONSTRAINT webhook_outbox_attempts_bound CHECK (attempts BETWEEN 0 AND 2147483647)
);

CREATE INDEX webhook_outbox_claim
  ON webhook_outbox(status, available_at, endpoint_id)
  WHERE status IN ('pending', 'processing', 'failed');
