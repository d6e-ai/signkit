CREATE TABLE idempotency_key (
  caller_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (caller_id, idempotency_key),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id)
);

CREATE INDEX envelope_created ON envelope(created_at DESC, id DESC);

CREATE INDEX idempotency_key_created_at
  ON idempotency_key(created_at);
