ALTER TABLE recipient_declined_command
  ADD COLUMN revocation_evidence_version integer NOT NULL DEFAULT 1,
  ADD COLUMN revoked_recipient_ids_json text NOT NULL DEFAULT '[]',
  ADD COLUMN revoked_recipient_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT recipient_declined_revocation_evidence_version
    CHECK (revocation_evidence_version IN (1, 2)),
  ADD CONSTRAINT recipient_declined_revoked_recipient_count
    CHECK (revoked_recipient_count >= 0);
