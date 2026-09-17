-- Recipient capability reissue, append-only outbox, and issuance ledger.
-- Allows reissuing delivery for released pending or viewed recipients,
-- creating an append-only capability lineage without mutating first-view evidence.

-- PostgreSQL auto-names the UNIQUE (envelope_id, recipient_id, kind) constraint
-- below 63 bytes, so a single DROP suffices.
ALTER TABLE delivery_outbox
  DROP CONSTRAINT IF EXISTS delivery_outbox_envelope_id_recipient_id_kind_key;

CREATE INDEX IF NOT EXISTS delivery_outbox_recipient
  ON delivery_outbox(envelope_id, recipient_id, kind, created_at);

CREATE TABLE recipient_capability_issuance (
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  capability_hash text NOT NULL,
  predecessor_capability_hash text,
  issued_at timestamptz NOT NULL,
  superseded_at timestamptz,
  PRIMARY KEY (capability_hash),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id)
);

CREATE INDEX recipient_capability_issuance_recipient
  ON recipient_capability_issuance(recipient_id, issued_at DESC);

-- Backfill trivial single-entry lineage for every existing recipient capability
INSERT INTO recipient_capability_issuance (
  envelope_id, recipient_id, capability_hash, predecessor_capability_hash, issued_at
)
SELECT envelope_id, id, capability_hash, NULL, created_at
FROM recipient
WHERE capability_hash IS NOT NULL
ON CONFLICT (capability_hash) DO NOTHING;

CREATE TABLE recipient_capability_reissue_command (
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  previous_capability_hash text NOT NULL,
  new_capability_hash text NOT NULL,
  reserved_capability_expires_at timestamptz NOT NULL,
  sealed_capability text NOT NULL,
  sealing_key_id text NOT NULL,
  sealed_capability_sha256 text NOT NULL,
  outbox_id text NOT NULL,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (audit_event_id),
  UNIQUE (new_capability_hash),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id)
);

CREATE INDEX recipient_capability_reissue_command_recipient
  ON recipient_capability_reissue_command(envelope_id, recipient_id, updated_at DESC);
