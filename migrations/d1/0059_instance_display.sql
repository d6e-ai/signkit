-- Encrypted, display-only member snapshots and invitation targets. Authorization
-- remains on zero-PII instance_member / instance_invitation rows. Ciphertext is
-- purpose-bound and is never a mail token payload.
CREATE TABLE instance_member_display (
  user_id TEXT NOT NULL PRIMARY KEY,
  sealed_payload TEXT NOT NULL,
  sealing_key_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES instance_member(user_id) ON DELETE CASCADE,
  CONSTRAINT instance_member_display_user_id_bound CHECK (
    length(user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_member_display_payload_bound CHECK (
    length(sealed_payload) BETWEEN 16 AND 8192
    AND sealed_payload GLOB 'skidm1_*'
  ),
  CONSTRAINT instance_member_display_key_id CHECK (
    length(sealing_key_id) = 16
    AND sealing_key_id NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_member_display_observed_at_iso CHECK (
    length(observed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at
  ),
  CONSTRAINT instance_member_display_expires_at_iso CHECK (
    length(expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  CONSTRAINT instance_member_display_stored_at_iso CHECK (
    length(stored_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', stored_at) IS stored_at
  ),
  CONSTRAINT instance_member_display_lifetime CHECK (
    datetime(expires_at) > datetime(observed_at)
  )
);

CREATE INDEX instance_member_display_expires
  ON instance_member_display(expires_at, user_id);

CREATE INDEX instance_member_display_reseal
  ON instance_member_display(sealing_key_id, expires_at, user_id);

CREATE TABLE instance_invitation_display (
  invitation_id TEXT NOT NULL PRIMARY KEY,
  sealed_payload TEXT NOT NULL,
  sealing_key_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (invitation_id) REFERENCES instance_invitation(id) ON DELETE CASCADE,
  CONSTRAINT instance_invitation_display_id_uuidv7 CHECK (
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
  CONSTRAINT instance_invitation_display_payload_bound CHECK (
    length(sealed_payload) BETWEEN 16 AND 8192
    AND sealed_payload GLOB 'skidt1_*'
  ),
  CONSTRAINT instance_invitation_display_key_id CHECK (
    length(sealing_key_id) = 16
    AND sealing_key_id NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_display_created_at_iso CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  CONSTRAINT instance_invitation_display_expires_at_iso CHECK (
    length(expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  CONSTRAINT instance_invitation_display_lifetime CHECK (
    datetime(expires_at) > datetime(created_at)
  )
);

CREATE INDEX instance_invitation_display_expires
  ON instance_invitation_display(expires_at, invitation_id);

CREATE INDEX instance_invitation_display_reseal
  ON instance_invitation_display(sealing_key_id, expires_at, invitation_id);

-- Acceptance and revocation atomically scrub the display-only target. Mail
-- ciphertext continues to scrub through the existing delivery trigger.
CREATE TRIGGER instance_invitation_display_terminal_scrub
AFTER UPDATE OF status ON instance_invitation
WHEN NEW.status IN ('accepted', 'revoked') AND OLD.status = 'pending'
BEGIN
  DELETE FROM instance_invitation_display WHERE invitation_id = NEW.id;
END;
