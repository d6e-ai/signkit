-- Keyed recipient lookup so a verified invitee can find and accept a pending
-- invitation without the emailed link. recipient_lookup is an HMAC of the
-- normalized invited email under a key derived from DELIVERY_ENCRYPTION_KEY;
-- the email itself is never stored. Invitations created before this migration
-- have no row and remain acceptable through their link only.
CREATE TABLE instance_invitation_recipient (
  invitation_id TEXT NOT NULL PRIMARY KEY,
  recipient_lookup TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (invitation_id) REFERENCES instance_invitation(id) ON DELETE CASCADE,
  CONSTRAINT instance_invitation_recipient_id_uuidv7 CHECK (
    length(invitation_id) = 36
    AND substr(invitation_id, 9, 1) = '-'
    AND substr(invitation_id, 14, 1) = '-'
    AND substr(invitation_id, 15, 1) = '7'
    AND substr(invitation_id, 19, 1) = '-'
    AND substr(invitation_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(invitation_id, 24, 1) = '-'
    AND length(replace(invitation_id, '-', '')) = 32
    AND replace(invitation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_recipient_lookup_hex CHECK (
    length(recipient_lookup) = 64
    AND recipient_lookup NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_recipient_created_at_iso CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  CONSTRAINT instance_invitation_recipient_expires_at_iso CHECK (
    length(expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  CONSTRAINT instance_invitation_recipient_lifetime CHECK (
    datetime(expires_at) > datetime(created_at)
  )
);

CREATE INDEX instance_invitation_recipient_lookup
  ON instance_invitation_recipient(recipient_lookup, expires_at);

CREATE INDEX instance_invitation_recipient_expires
  ON instance_invitation_recipient(expires_at, invitation_id);

-- Acceptance and revocation (including the revocations cascaded by member
-- suspension or demotion) atomically scrub the lookup. Expired rows are
-- removed by the next invitation create.
CREATE TRIGGER instance_invitation_recipient_terminal_scrub
AFTER UPDATE OF status ON instance_invitation
WHEN NEW.status IN ('accepted', 'revoked') AND OLD.status = 'pending'
BEGIN
  DELETE FROM instance_invitation_recipient WHERE invitation_id = NEW.id;
END;
