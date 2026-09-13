-- Zero-PII instance member administration (set_role/set_status) command
-- receipts, one row per Idempotency-Key attempt, mirroring
-- instance_invitation_command's actor/idempotency-scoped primary key. No
-- email or other PII is stored; only the role/status transition on an
-- already-durable instance_member row plus the count of the target's own
-- pending invitations cascade-revoked as a side effect (see
-- SetInstanceMemberRoleCommand/SetInstanceMemberStatusCommand in
-- $lib/ports/instance-store.ts). Unlike instance_invitation_command, a
-- member can be administered repeatedly over its lifetime, so there is no
-- UNIQUE(target_user_id, command_type) cap here.
--
-- D1 has no adapter-visible SERIALIZABLE isolation, so the invariants a
-- PostgreSQL adapter would otherwise enforce at runtime with SELECT ... FOR
-- UPDATE / advisory locks plus application logic are instead enforced here
-- with durable triggers:
--
--   * instance_member_immutable_fields_guard rejects identity (`user_id`)
--     and `created_at` changes, and any `updated_at` regression, on every
--     UPDATE to instance_member.
--   * instance_member_owner_floor_guard rejects every UPDATE that would
--     take the instance's last active owner out of that role or status,
--     receipt or no receipt. The owner floor therefore holds for direct
--     writes -- a raw demotion or suspension of the last active owner
--     aborts at the UPDATE itself, before anything commits -- and not only
--     for writes an adapter bothers to follow with a receipt. SQLite fires
--     the trigger once per updated row against the table as already
--     mutated by the earlier rows of the same statement, so a single
--     multi-row UPDATE demoting every owner aborts on its last owner and
--     rolls the whole statement back.
--   * instance_member_no_delete_guard rejects every DELETE on
--     instance_member; members are suspended, never removed. Together with
--     the owner floor guard this makes "at least one active owner" an
--     invariant of the table rather than of the adapter.
--   * instance_member_command_immutable_guard and
--     instance_member_command_no_delete_guard keep receipts append-only, so
--     a replay answered from a receipt is answered from the row the
--     evidence guard admitted and from nothing else.
--   * instance_member_command_evidence_guard runs AFTER INSERT on this
--     table -- i.e. after a legitimate atomic adapter batch has already
--     updated instance_member and cascade-revoked any invitations the
--     target can no longer hold, in that order -- and checks that the actor
--     was a currently active owner or admin, that an admin actor only ever
--     touched a target that was (and, for set_role, still is) a plain
--     member, that the target's current row exactly matches the receipt's
--     claimed result at occurred_at, that revoked_invitation_count does not
--     exceed the invitations of the target actually revoked at that
--     instant, and that the instance still retains an active owner. A
--     self-targeting command can't read the actor's pre-update role/status
--     back out of instance_member -- the UPDATE already landed by the time
--     this trigger runs -- so the guard falls back to this row's own
--     previous_role/previous_status whenever actor_id equals
--     target_user_id.
--
-- What each evidence column is worth, stated plainly rather than implied:
--
--   * previous_role is durable evidence for set_status commands only: the
--     command-type/field pairing constraint forces previous_role =
--     result_role there, and result_role is matched against the target's
--     current row. For set_role the pre-command role is the receipt's own
--     claim -- no table records the value a row held before an UPDATE.
--   * previous_status is durable evidence the same way for set_role
--     commands, and a claim for set_status. Self-targeting is reachable
--     only for set_role by an active owner (set_status may never
--     self-target, and an admin may only administer a current member-role
--     target, which its own row never is), which is pinned row-locally by
--     instance_member_command_self_target_active_owner.
--   * revoked_invitation_count is adapter-recorded transactional evidence
--     bounded from above by the target's invitations actually revoked at
--     occurred_at. It is deliberately not an equality: several revokes can
--     share one millisecond -- an unrelated explicit revoke of another of
--     the target's invitations, or a cascade from a different command --
--     and an equality check would reject valid commands for that alone.
--     Exact attribution would take a command correlation column on
--     instance_invitation, which that schema does not carry and which this
--     migration does not add.
CREATE TABLE instance_member_command (
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  previous_role TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  result_role TEXT NOT NULL,
  result_status TEXT NOT NULL,
  revoked_invitation_count INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  FOREIGN KEY (actor_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (target_user_id) REFERENCES instance_member(user_id),
  CONSTRAINT instance_member_command_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_member_command_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT instance_member_command_type_known CHECK (
    command_type IN ('set_role', 'set_status')
  ),
  CONSTRAINT instance_member_command_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_member_command_target_bound CHECK (
    length(target_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_member_command_previous_role_known CHECK (
    previous_role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT instance_member_command_previous_status_known CHECK (
    previous_status IN ('active', 'suspended')
  ),
  CONSTRAINT instance_member_command_result_role_known CHECK (
    result_role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT instance_member_command_result_status_known CHECK (
    result_status IN ('active', 'suspended')
  ),
  -- set_role never changes status and set_status never changes role: each
  -- command mutates exactly one axis of member state.
  CONSTRAINT instance_member_command_type_field_pair CHECK (
    (command_type = 'set_role' AND previous_status = result_status)
    OR (command_type = 'set_status' AND previous_role = result_role)
  ),
  CONSTRAINT instance_member_command_no_status_self_target CHECK (
    command_type <> 'set_status' OR target_user_id <> actor_id
  ),
  -- The only self-targeting command an adapter can legitimately reach is a
  -- set_role by an active owner, so the previous_* fallback the evidence
  -- guard uses for self-targets is pinned to exactly that here rather than
  -- left to the trigger to infer.
  CONSTRAINT instance_member_command_self_target_active_owner CHECK (
    target_user_id <> actor_id
    OR (previous_role = 'owner' AND previous_status = 'active')
  ),
  CONSTRAINT instance_member_command_revoked_count_bound CHECK (
    revoked_invitation_count >= 0
  ),
  -- Only a suspension or a role demotion takes invitation capability away
  -- from the target, so only those two can cascade-revoke anything;
  -- reactivating or promoting a member revokes nothing.
  CONSTRAINT instance_member_command_cascade_requires_demotion CHECK (
    revoked_invitation_count = 0
    OR (command_type = 'set_status' AND result_status = 'suspended')
    OR (
      command_type = 'set_role'
      AND (
        (previous_role = 'owner' AND result_role IN ('admin', 'member'))
        OR (previous_role = 'admin' AND result_role = 'member')
      )
    )
  ),
  CONSTRAINT instance_member_command_occurred_at_iso CHECK (
    length(occurred_at) = 24
    AND occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(occurred_at) IS NOT NULL
  )
);

CREATE INDEX instance_member_command_target_type_occurred
  ON instance_member_command(target_user_id, command_type, occurred_at DESC);

CREATE INDEX instance_member_command_actor_occurred
  ON instance_member_command(actor_id, occurred_at DESC);

CREATE TRIGGER instance_member_immutable_fields_guard
BEFORE UPDATE ON instance_member
BEGIN
  SELECT (CASE
    WHEN NEW.user_id <> OLD.user_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.updated_at < OLD.updated_at
    THEN RAISE(ABORT, 'cannot modify immutable instance member fields')
  END);
END;

-- The owner floor, enforced on the write itself rather than on the receipt
-- that is supposed to follow it. Only an UPDATE that takes an active owner
-- row out of the active-owner set can lower the count, so that is the only
-- case this trigger examines: an instance that already has no active owner
-- (nothing bootstrapped yet) is left alone rather than frozen.
CREATE TRIGGER instance_member_owner_floor_guard
BEFORE UPDATE ON instance_member
WHEN OLD.role = 'owner'
  AND OLD.status = 'active'
  AND NOT (NEW.role = 'owner' AND NEW.status = 'active')
BEGIN
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM instance_member
      WHERE role = 'owner'
        AND status = 'active'
        AND user_id <> OLD.user_id
    )
    THEN RAISE(ABORT, 'instance must retain at least one active owner')
  END);
END;

CREATE TRIGGER instance_member_no_delete_guard
BEFORE DELETE ON instance_member
BEGIN
  SELECT RAISE(ABORT, 'instance members cannot be deleted');
END;

CREATE TRIGGER instance_member_command_immutable_guard
BEFORE UPDATE ON instance_member_command
BEGIN
  SELECT RAISE(ABORT, 'instance member command receipts are append-only');
END;

CREATE TRIGGER instance_member_command_no_delete_guard
BEFORE DELETE ON instance_member_command
BEGIN
  SELECT RAISE(ABORT, 'instance member command receipts are append-only');
END;

CREATE TRIGGER instance_member_command_evidence_guard
AFTER INSERT ON instance_member_command
BEGIN
  -- The actor must have been a currently active owner or admin immediately
  -- before this command. Non-self-targeting commands never touch the
  -- actor's own row in the same batch, so its current instance_member state
  -- already is that pre-command evidence; a self-targeting command already
  -- overwrote that row, so fall back to the receipt's own previous_*
  -- columns, which describe the target -- i.e. the actor itself here, and
  -- which instance_member_command_self_target_active_owner pins to an
  -- active owner.
  SELECT (CASE
    WHEN (
      (CASE WHEN NEW.actor_id = NEW.target_user_id THEN NEW.previous_status
        ELSE (SELECT status FROM instance_member WHERE user_id = NEW.actor_id)
      END)
    ) <> 'active'
    OR (
      (CASE WHEN NEW.actor_id = NEW.target_user_id THEN NEW.previous_role
        ELSE (SELECT role FROM instance_member WHERE user_id = NEW.actor_id)
      END)
    ) NOT IN ('owner', 'admin')
    THEN RAISE(ABORT, 'instance member command actor evidence conflict')
  END);

  -- An admin actor may only administer a target that was a plain member
  -- immediately before this command, and set_role may never grant that
  -- target a role above member.
  SELECT (CASE
    WHEN (
      (CASE WHEN NEW.actor_id = NEW.target_user_id THEN NEW.previous_role
        ELSE (SELECT role FROM instance_member WHERE user_id = NEW.actor_id)
      END)
    ) = 'admin'
    AND (
      NEW.previous_role <> 'member'
      OR (NEW.command_type = 'set_role' AND NEW.result_role <> 'member')
    )
    THEN RAISE(ABORT, 'instance member command role ceiling conflict')
  END);

  -- The target's current row must exactly match the receipt's claimed
  -- result, timestamped at occurred_at.
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM instance_member
      WHERE user_id = NEW.target_user_id
        AND role = NEW.result_role
        AND status = NEW.result_status
        AND updated_at = NEW.occurred_at
    )
    THEN RAISE(ABORT, 'instance member command receipt state mismatch')
  END);

  -- revoked_invitation_count may not claim more cascade-revoked
  -- invitations than the target actually had revoked at this instant. An
  -- equality would be unsound in the other direction: an unrelated revoke
  -- of another invitation of the target's, landing on the same millisecond,
  -- would make a truthful count look wrong. Attributing an individual
  -- revoke to an individual command needs a correlation column this schema
  -- does not have, so this stays a bound and the exact figure stays
  -- adapter-recorded evidence written in the same atomic batch.
  SELECT (CASE
    WHEN NEW.revoked_invitation_count > (
      SELECT COUNT(*) FROM instance_invitation
      WHERE invited_by_user_id = NEW.target_user_id
        AND status = 'revoked'
        AND revoked_at = NEW.occurred_at
    )
    THEN RAISE(ABORT, 'instance member command revoked invitation count exceeds revoked invitations')
  END);

  -- Backstop for the owner floor that instance_member_owner_floor_guard
  -- already enforces on every UPDATE: a receipt may never be recorded
  -- against an instance with no active owner at all.
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM instance_member WHERE role = 'owner' AND status = 'active'
    )
    THEN RAISE(ABORT, 'instance member command leaves no active owner')
  END);
END;
