CREATE TABLE webhook_delivery_log (
  id text NOT NULL,
  organization_id text NOT NULL,
  endpoint_id text NOT NULL,
  audit_event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL,
  http_status integer,
  error_code text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, endpoint_id, audit_event_id)
    REFERENCES webhook_outbox(organization_id, endpoint_id, audit_event_id),
  CONSTRAINT webhook_delivery_log_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT webhook_delivery_log_status_known CHECK (
    status IN ('delivered', 'failed', 'retrying')
  )
);

CREATE INDEX webhook_delivery_log_endpoint
  ON webhook_delivery_log(organization_id, endpoint_id, occurred_at DESC, id DESC);
