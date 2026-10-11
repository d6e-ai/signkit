-- Completion access reissue: an append-only successor chain on the existing
-- completion delivery outbox. A reissue never mutates the predecessor row --
-- its original status, attempts, error, revocation, and expiry stay exactly
-- as the exhausting failure wrote them -- it only appends a new generation
-- chained to it by `predecessor_delivery_id`. The read side (current
-- generation) is therefore "no successor yet, or the newest one".

ALTER TABLE completion_delivery_outbox
  DROP CONSTRAINT completion_delivery_outbox_envelope_id_recipient_id_key;

ALTER TABLE completion_delivery_outbox
  ADD COLUMN generation integer NOT NULL DEFAULT 0,
  ADD COLUMN predecessor_delivery_id text,
  -- The exhausting failure's real cause, preserved separately from
  -- `last_error`, which that same failure overwrites to the generic
  -- `delivery_attempts_exhausted` classification. A row written before this
  -- column existed has no recoverable original cause, so it stays NULL
  -- (unknown) rather than being guessed from the overwritten value.
  ADD COLUMN failure_cause_code text;

ALTER TABLE completion_delivery_outbox
  ADD CONSTRAINT completion_delivery_outbox_generation_check CHECK (generation >= 0),
  ADD CONSTRAINT completion_delivery_outbox_envelope_recipient_generation_key
    UNIQUE (envelope_id, recipient_id, generation),
  ADD CONSTRAINT completion_delivery_outbox_predecessor_fk
    FOREIGN KEY (predecessor_delivery_id) REFERENCES completion_delivery_outbox(id),
  ADD CONSTRAINT completion_delivery_outbox_predecessor_unique
    UNIQUE (predecessor_delivery_id),
  ADD CONSTRAINT completion_delivery_outbox_generation_predecessor_check CHECK (
    (generation = 0 AND predecessor_delivery_id IS NULL) OR
    (generation > 0 AND predecessor_delivery_id IS NOT NULL)
  );

CREATE INDEX completion_delivery_outbox_current_generation
  ON completion_delivery_outbox(envelope_id, recipient_id, generation DESC);

-- Operator reissue receipts. The CAS tuple (`expected_attempts`,
-- `expected_failed_at`, `expected_error_code`) is the exact exhaustion
-- generation the caller observed in the read side: it keeps a stale or
-- duplicate command from reissuing a predecessor a concurrent reissue (or a
-- fresh retryable failure cycle) has already moved past. The ciphertext for
-- the new grant is written straight to `completion_delivery_outbox` by the
-- same transaction that inserts this row -- never duplicated here -- so
-- there is nothing to scrub on this table in PostgreSQL.
CREATE TABLE completion_access_reissue_command (
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  predecessor_delivery_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expected_attempts integer NOT NULL CHECK (expected_attempts >= 0),
  expected_failed_at timestamptz NOT NULL,
  expected_error_code text NOT NULL,
  -- The completion manifest and PDF digests the caller verified against
  -- object storage, outside this transaction, immediately before this row
  -- was inserted. The publishing transaction rechecks these against the
  -- current `completion_artifact` / `completion_artifact_pdf` rows -- never
  -- against object storage again -- so a repair that replaces the artifact
  -- mid-flight is caught without doing object-storage IO under the lock.
  expected_json_sha256 text NOT NULL,
  expected_markdown_sha256 text NOT NULL,
  expected_pdf_sha256 text NOT NULL,
  new_delivery_id text NOT NULL,
  new_access_expires_at timestamptz NOT NULL,
  reissued_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (audit_event_id),
  UNIQUE (new_delivery_id),
  UNIQUE (predecessor_delivery_id),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id),
  FOREIGN KEY (predecessor_delivery_id) REFERENCES completion_delivery_outbox(id),
  FOREIGN KEY (new_delivery_id) REFERENCES completion_delivery_outbox(id)
);

CREATE INDEX completion_access_reissue_command_recipient
  ON completion_access_reissue_command(envelope_id, recipient_id, reissued_at DESC);
