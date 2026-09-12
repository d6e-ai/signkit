-- Zero-PII instance invitations. No plaintext email, name, or invitation
-- token is ever persisted. token_hash is the globally unique SHA-256 digest
-- of the bearer token (ski1_ prefix, see $lib/security/instance-invitation);
-- email_binding is the SHA-256 digest of that token bound to the invited
-- email address and is verified only at accept time against the email the
-- accepting caller asserts. Neither column can be reversed or correlated
-- back to an email address without already knowing both the raw token and
-- the candidate address, so the schema itself cannot be used to enumerate
-- invited emails. Invitations expire at most 7 days after creation and are
-- terminal once accepted or revoked; accept requires the accepting member to
-- already exist in instance_member by the time this row is written,
-- mirroring instance_bootstrap_command's same-transaction ordering for the
-- singleton owner.
CREATE TABLE instance_invitation (
  id text NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  token_hash text NOT NULL,
  email_binding text NOT NULL,
  invited_by_user_id text NOT NULL REFERENCES instance_member(user_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_user_id text REFERENCES instance_member(user_id),
  revoked_at timestamptz,
  revoked_by_user_id text REFERENCES instance_member(user_id),
  PRIMARY KEY (id),
  CONSTRAINT instance_invitation_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT instance_invitation_role_known CHECK (
    role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT instance_invitation_status_known CHECK (
    status IN ('pending', 'accepted', 'revoked')
  ),
  CONSTRAINT instance_invitation_token_hash_sha256 CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT instance_invitation_email_binding_sha256 CHECK (
    email_binding ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT instance_invitation_invited_by_bound CHECK (
    char_length(invited_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_expiry_bound CHECK (
    expires_at > created_at
    AND expires_at <= created_at + INTERVAL '7 days'
  ),
  CONSTRAINT instance_invitation_accepted_by_bound CHECK (
    accepted_by_user_id IS NULL
    OR char_length(accepted_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_accepted_at_order CHECK (
    accepted_at IS NULL OR accepted_at >= created_at
  ),
  CONSTRAINT instance_invitation_revoked_by_bound CHECK (
    revoked_by_user_id IS NULL
    OR char_length(revoked_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_revoked_at_order CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  ),
  CONSTRAINT instance_invitation_terminal_exclusive CHECK (
    (status = 'pending'
      AND accepted_at IS NULL AND accepted_by_user_id IS NULL
      AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (status = 'accepted'
      AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL
      AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (status = 'revoked'
      AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
      AND accepted_at IS NULL AND accepted_by_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX instance_invitation_token_hash
  ON instance_invitation(token_hash);

CREATE INDEX instance_invitation_status_created
  ON instance_invitation(status, created_at DESC, id DESC);

CREATE INDEX instance_invitation_invited_by_created
  ON instance_invitation(invited_by_user_id, created_at DESC, id DESC);

-- Durable create/accept/revoke command receipts in one table keyed by actor
-- and Idempotency-Key. UNIQUE(invitation_id, command_type) caps every
-- invitation at exactly one create, one accept, and one revoke receipt, so
-- an exact replay of any of the three commands is provable from this table
-- alone. No token, email, or email_binding column: a receipt holds only the
-- request fingerprint and the resulting invitation evidence.
CREATE TABLE instance_invitation_command (
  actor_type text NOT NULL CHECK (actor_type = 'user'),
  actor_id text NOT NULL REFERENCES instance_member(user_id),
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  request_hash text NOT NULL,
  invitation_id text NOT NULL REFERENCES instance_invitation(id),
  role text NOT NULL,
  result_status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (invitation_id, command_type),
  CONSTRAINT instance_invitation_command_actor_bound CHECK (
    char_length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_command_idempotency_bound CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key ~ '^[\x21-\x7E]+$'
  ),
  CONSTRAINT instance_invitation_command_type_known CHECK (
    command_type IN ('create', 'accept', 'revoke')
  ),
  CONSTRAINT instance_invitation_command_request_hash_sha256 CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT instance_invitation_command_role_known CHECK (
    role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT instance_invitation_command_result_status_known CHECK (
    result_status IN ('pending', 'accepted', 'revoked')
  ),
  CONSTRAINT instance_invitation_command_type_result_pair CHECK (
    (command_type = 'create' AND result_status = 'pending')
    OR (command_type = 'accept' AND result_status = 'accepted')
    OR (command_type = 'revoke' AND result_status = 'revoked')
  )
);
