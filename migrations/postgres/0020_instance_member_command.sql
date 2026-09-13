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
-- Unlike the D1 migration, this table carries no triggers: PostgreSQL
-- adapters enforce actor/role-ceiling evidence, the receipt/state match, and
-- the no-zero-active-owners invariant at runtime inside a transaction (with
-- advisory locking as needed), the same way instance_invitation's create,
-- accept, and revoke commands already do on this database. A row-level
-- trigger could not carry the owner floor here anyway: under READ COMMITTED
-- two concurrent demotions would each still see the other's owner as
-- active, so the floor holds only where the adapter takes the locks. Only
-- the self-contained, row-local invariants below are captured as CHECK
-- constraints here, and they are kept identical to the D1 table's so a
-- receipt that one provider accepts is a receipt the other accepts too.
--
-- revoked_invitation_count is adapter-recorded transactional evidence: it is
-- written in the same transaction as the cascade it counts, but no column
-- links an individual instance_invitation revoke back to an individual
-- command, so the count is not independently attributable after the fact.
-- The D1 migration says the same and bounds the claim rather than asserting
-- an equality that unrelated same-instant revokes would break.
CREATE TABLE instance_member_command (
  actor_type text NOT NULL CHECK (actor_type = 'user'),
  actor_id text NOT NULL REFERENCES instance_member(user_id),
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  request_hash text NOT NULL,
  target_user_id text NOT NULL REFERENCES instance_member(user_id),
  previous_role text NOT NULL,
  previous_status text NOT NULL,
  result_role text NOT NULL,
  result_status text NOT NULL,
  revoked_invitation_count integer NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  CONSTRAINT instance_member_command_actor_bound CHECK (
    char_length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_member_command_idempotency_bound CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key ~ '^[\x21-\x7E]+$'
  ),
  CONSTRAINT instance_member_command_type_known CHECK (
    command_type IN ('set_role', 'set_status')
  ),
  CONSTRAINT instance_member_command_request_hash_sha256 CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT instance_member_command_target_bound CHECK (
    char_length(target_user_id) BETWEEN 1 AND 200
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
  -- set_role by an active owner: set_status may never self-target, and an
  -- admin may only administer a target whose current role is member, which
  -- its own row never is.
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
  )
);

CREATE INDEX instance_member_command_target_type_occurred
  ON instance_member_command(target_user_id, command_type, occurred_at DESC);

CREATE INDEX instance_member_command_actor_occurred
  ON instance_member_command(actor_id, occurred_at DESC);
