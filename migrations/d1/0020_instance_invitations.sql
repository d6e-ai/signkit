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
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  email_binding TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user_id TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (invited_by_user_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (accepted_by_user_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (revoked_by_user_id) REFERENCES instance_member(user_id),
  CONSTRAINT instance_invitation_id_uuidv7 CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_role_known CHECK (
    role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT instance_invitation_status_known CHECK (
    status IN ('pending', 'accepted', 'revoked')
  ),
  CONSTRAINT instance_invitation_token_hash_sha256 CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_email_binding_sha256 CHECK (
    length(email_binding) = 64
    AND email_binding NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_invitation_invited_by_bound CHECK (
    length(invited_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_created_at_iso CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  CONSTRAINT instance_invitation_expires_at_iso CHECK (
    length(expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  CONSTRAINT instance_invitation_expiry_bound CHECK (
    datetime(expires_at) > datetime(created_at)
    AND datetime(expires_at) <= datetime(created_at, '+7 days')
  ),
  CONSTRAINT instance_invitation_accepted_by_bound CHECK (
    accepted_by_user_id IS NULL
    OR length(accepted_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_accepted_at_iso CHECK (
    accepted_at IS NULL OR (
      length(accepted_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at
      AND datetime(accepted_at) >= datetime(created_at)
    )
  ),
  CONSTRAINT instance_invitation_revoked_by_bound CHECK (
    revoked_by_user_id IS NULL
    OR length(revoked_by_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_revoked_at_iso CHECK (
    revoked_at IS NULL OR (
      length(revoked_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at
      AND datetime(revoked_at) >= datetime(created_at)
    )
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
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  result_status TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  UNIQUE (invitation_id, command_type),
  FOREIGN KEY (actor_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (invitation_id) REFERENCES instance_invitation(id),
  CONSTRAINT instance_invitation_command_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_invitation_command_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT instance_invitation_command_type_known CHECK (
    command_type IN ('create', 'accept', 'revoke')
  ),
  CONSTRAINT instance_invitation_command_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
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
  ),
  CONSTRAINT instance_invitation_command_occurred_at_iso CHECK (
    length(occurred_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at
  )
);

CREATE TRIGGER instance_invitation_immutable_fields_guard
BEFORE UPDATE ON instance_invitation
BEGIN
  SELECT (CASE
    WHEN OLD.status IN ('accepted', 'revoked')
      OR NEW.id <> OLD.id
      OR NEW.token_hash <> OLD.token_hash
      OR NEW.email_binding <> OLD.email_binding
      OR NEW.invited_by_user_id <> OLD.invited_by_user_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.expires_at <> OLD.expires_at
      OR NEW.role <> OLD.role
    THEN RAISE(ABORT, 'cannot modify immutable instance invitation fields')
  END);
END;

CREATE TRIGGER instance_invitation_command_evidence_guard
AFTER INSERT ON instance_invitation_command
BEGIN
  -- Validate CREATE command evidence
  SELECT (CASE
    WHEN NEW.command_type = 'create' AND (
      NEW.result_status <> 'pending'
      OR NOT EXISTS (
        SELECT 1 FROM instance_member
        WHERE user_id = NEW.actor_id AND status = 'active' AND role IN ('owner', 'admin')
      )
      OR (
        (SELECT role FROM instance_member WHERE user_id = NEW.actor_id) = 'admin'
        AND NEW.role <> 'member'
      )
      OR (
        -- Lexical comparison, not datetime(): both columns are canonical UTC
        -- millisecond ISO-8601 strings, so string ordering matches
        -- chronological ordering exactly, whereas datetime() truncates to
        -- whole seconds and would misclassify invitations expiring within
        -- the same second.
        SELECT COUNT(*) FROM instance_invitation
        WHERE status = 'pending'
          AND expires_at > NEW.occurred_at
      -- 200 mirrors MAX_PENDING_INSTANCE_INVITATIONS in
      -- src/lib/ports/instance-store.ts; keep both in sync.
      ) > 200
      OR NOT EXISTS (
        SELECT 1 FROM instance_invitation
        WHERE id = NEW.invitation_id
          AND role = NEW.role
          AND status = 'pending'
          AND invited_by_user_id = NEW.actor_id
          AND created_at = NEW.occurred_at
      )
    )
    THEN RAISE(ABORT, 'instance invitation create evidence conflict')
  END);

  -- Validate ACCEPT command evidence
  SELECT (CASE
    WHEN NEW.command_type = 'accept' AND (
      NEW.result_status <> 'accepted'
      OR NOT EXISTS (
        SELECT 1 FROM instance_member
        WHERE user_id = NEW.actor_id AND status = 'active'
      )
      OR NOT EXISTS (
        SELECT 1 FROM instance_invitation
        WHERE id = NEW.invitation_id
          AND role = NEW.role
          AND status = 'accepted'
          AND accepted_by_user_id = NEW.actor_id
          AND accepted_at = NEW.occurred_at
          -- Lexical comparison: see the create-evidence check above.
          AND expires_at > NEW.occurred_at
      )
    )
    THEN RAISE(ABORT, 'instance invitation accept evidence conflict')
  END);

  -- Validate REVOKE command evidence
  SELECT (CASE
    WHEN NEW.command_type = 'revoke' AND (
      NEW.result_status <> 'revoked'
      OR NOT EXISTS (
        SELECT 1 FROM instance_member
        WHERE user_id = NEW.actor_id AND status = 'active' AND role IN ('owner', 'admin')
      )
      OR (
        (SELECT role FROM instance_member WHERE user_id = NEW.actor_id) = 'admin'
        AND NEW.role <> 'member'
      )
      OR NOT EXISTS (
        SELECT 1 FROM instance_invitation
        WHERE id = NEW.invitation_id
          AND role = NEW.role
          AND status = 'revoked'
          AND revoked_by_user_id = NEW.actor_id
          AND revoked_at = NEW.occurred_at
      )
    )
    THEN RAISE(ABORT, 'instance invitation revoke evidence conflict')
  END);
END;
