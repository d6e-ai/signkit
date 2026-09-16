-- Audit hash v3: the single hash version. Its preimage is instance-scoped
-- (no tenant field) and includes hashVersion, actorType, and actorId for
-- every event. Old databases must be reset; there is no upgrade path.
ALTER TABLE audit_event
  ADD COLUMN hash_version integer NOT NULL DEFAULT 3;

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_hash_version_known CHECK (hash_version = 3);

-- Instance invitation immutability and command-evidence guards, matching the
-- D1 rollback-on-failed-predicate triggers in migrations/d1/0020_instance_invitations.sql.
CREATE OR REPLACE FUNCTION instance_invitation_immutable_fields_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('accepted', 'revoked')
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.email_binding IS DISTINCT FROM OLD.email_binding
     OR NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.role IS DISTINCT FROM OLD.role
  THEN
    RAISE EXCEPTION 'cannot modify immutable instance invitation fields';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instance_invitation_immutable_fields_guard
BEFORE UPDATE ON instance_invitation
FOR EACH ROW
EXECUTE FUNCTION instance_invitation_immutable_fields_guard();

CREATE OR REPLACE FUNCTION instance_invitation_command_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.command_type = 'create' THEN
    IF NEW.result_status <> 'pending'
       OR NOT EXISTS (
         SELECT 1 FROM instance_member
         WHERE user_id = NEW.actor_id AND status = 'active' AND role IN ('owner', 'admin')
       )
       OR (
         (SELECT role FROM instance_member WHERE user_id = NEW.actor_id) = 'admin'
         AND NEW.role <> 'member'
       )
       OR (
         SELECT COUNT(*) FROM instance_invitation
         WHERE status = 'pending' AND expires_at > NEW.occurred_at
       ) > 200
       OR NOT EXISTS (
         SELECT 1 FROM instance_invitation
         WHERE id = NEW.invitation_id
           AND role = NEW.role
           AND status = 'pending'
           AND invited_by_user_id = NEW.actor_id
           AND created_at = NEW.occurred_at
       )
    THEN
      RAISE EXCEPTION 'instance invitation create evidence conflict';
    END IF;
  ELSIF NEW.command_type = 'accept' THEN
    IF NEW.result_status <> 'accepted'
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
           AND expires_at > NEW.occurred_at
       )
    THEN
      RAISE EXCEPTION 'instance invitation accept evidence conflict';
    END IF;
  ELSIF NEW.command_type = 'revoke' THEN
    IF NEW.result_status <> 'revoked'
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
    THEN
      RAISE EXCEPTION 'instance invitation revoke evidence conflict';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instance_invitation_command_evidence_guard
AFTER INSERT ON instance_invitation_command
FOR EACH ROW
EXECUTE FUNCTION instance_invitation_command_evidence_guard();
