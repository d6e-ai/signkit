CREATE TABLE idempotency_key (
  organization_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, caller_id, idempotency_key),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id)
);

CREATE INDEX envelope_org_created ON envelope(organization_id, created_at DESC, id DESC);

CREATE INDEX idempotency_key_created_at
  ON idempotency_key(organization_id, created_at);
