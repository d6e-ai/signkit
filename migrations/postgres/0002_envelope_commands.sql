-- `idempotency_key` is caller-chosen opaque text and stays unconstrained; the
-- envelope it resolves to is UUIDv7-checked by its own table.
CREATE TABLE idempotency_key (
  caller_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  envelope_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (caller_id, idempotency_key),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id)
);

CREATE INDEX envelope_created ON envelope(created_at DESC, id DESC);

CREATE INDEX idempotency_key_created_at
  ON idempotency_key(created_at);
