-- Keyed recipient lookup so a verified invitee can find and accept a pending
-- invitation without the emailed link. recipient_lookup is an HMAC of the
-- normalized invited email under a key derived from DELIVERY_ENCRYPTION_KEY;
-- the email itself is never stored. Invitations created before this migration
-- have no row and remain acceptable through their link only.
CREATE TABLE instance_invitation_recipient (
  invitation_id text NOT NULL PRIMARY KEY REFERENCES instance_invitation(id) ON DELETE CASCADE,
  recipient_lookup text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT instance_invitation_recipient_id_uuidv7 CHECK (
    invitation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT instance_invitation_recipient_lookup_hex CHECK (
    recipient_lookup ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT instance_invitation_recipient_lifetime CHECK (
    expires_at > created_at
  )
);

CREATE INDEX instance_invitation_recipient_lookup
  ON instance_invitation_recipient(recipient_lookup, expires_at);

CREATE INDEX instance_invitation_recipient_expires
  ON instance_invitation_recipient(expires_at, invitation_id);

-- Acceptance and revocation (including the revocations cascaded by member
-- suspension or demotion) atomically scrub the lookup. Expired rows are
-- removed by the next invitation create.
CREATE FUNCTION scrub_terminal_instance_invitation_recipient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('accepted', 'revoked') AND OLD.status = 'pending' THEN
    DELETE FROM instance_invitation_recipient WHERE invitation_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instance_invitation_recipient_terminal_scrub
AFTER UPDATE OF status ON instance_invitation
FOR EACH ROW EXECUTE FUNCTION scrub_terminal_instance_invitation_recipient();
