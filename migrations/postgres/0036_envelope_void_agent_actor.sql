-- API-key voids record actor_type = 'agent'. Drop the original
-- CHECK (actor_type = 'user') so audit hash v2 can stamp envelope.voided
-- with the agent that actually issued the command.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = current_schema()
      AND rel.relname = 'envelope_void_command'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%actor_type%'
  LOOP
    EXECUTE format('ALTER TABLE envelope_void_command DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

ALTER TABLE envelope_void_command
  ADD CONSTRAINT envelope_void_command_actor_type_known
  CHECK (actor_type IN ('user', 'agent'));
