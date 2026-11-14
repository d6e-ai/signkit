-- Encrypted, display-only member snapshots and invitation targets. Authorization
-- remains on zero-PII instance_member / instance_invitation rows. Ciphertext is
-- purpose-bound and is never a mail token payload.
CREATE TABLE instance_member_display (
  user_id text NOT NULL PRIMARY KEY REFERENCES instance_member(user_id) ON DELETE CASCADE,
  sealed_payload text NOT NULL,
  sealing_key_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  stored_at timestamptz NOT NULL,
  reseal_after timestamptz NOT NULL DEFAULT TIMESTAMPTZ '1970-01-01T00:00:00.000Z',
  CONSTRAINT instance_member_display_user_id_bound CHECK (
    char_length(user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_member_display_payload_bound CHECK (
    char_length(sealed_payload) BETWEEN 16 AND 8192
    AND sealed_payload LIKE 'skidm1_%'
  ),
  CONSTRAINT instance_member_display_key_id CHECK (
    sealing_key_id ~ '^[0-9a-f]{16}$'
  ),
  CONSTRAINT instance_member_display_lifetime CHECK (
    expires_at > observed_at
  )
);

CREATE INDEX instance_member_display_expires
  ON instance_member_display(expires_at, user_id);

CREATE INDEX instance_member_display_reseal
  ON instance_member_display(sealing_key_id, reseal_after, expires_at, user_id);

CREATE TABLE instance_invitation_display (
  invitation_id text NOT NULL PRIMARY KEY REFERENCES instance_invitation(id) ON DELETE CASCADE,
  sealed_payload text NOT NULL,
  sealing_key_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  reseal_after timestamptz NOT NULL DEFAULT TIMESTAMPTZ '1970-01-01T00:00:00.000Z',
  CONSTRAINT instance_invitation_display_id_uuidv7 CHECK (
    invitation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT instance_invitation_display_payload_bound CHECK (
    char_length(sealed_payload) BETWEEN 16 AND 8192
    AND sealed_payload LIKE 'skidt1_%'
  ),
  CONSTRAINT instance_invitation_display_key_id CHECK (
    sealing_key_id ~ '^[0-9a-f]{16}$'
  ),
  CONSTRAINT instance_invitation_display_lifetime CHECK (
    expires_at > created_at
  )
);

CREATE INDEX instance_invitation_display_expires
  ON instance_invitation_display(expires_at, invitation_id);

CREATE INDEX instance_invitation_display_reseal
  ON instance_invitation_display(sealing_key_id, reseal_after, expires_at, invitation_id);

CREATE FUNCTION scrub_terminal_instance_invitation_display() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('accepted', 'revoked') AND OLD.status = 'pending' THEN
    DELETE FROM instance_invitation_display WHERE invitation_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instance_invitation_display_terminal_scrub
AFTER UPDATE OF status ON instance_invitation
FOR EACH ROW EXECUTE FUNCTION scrub_terminal_instance_invitation_display();
