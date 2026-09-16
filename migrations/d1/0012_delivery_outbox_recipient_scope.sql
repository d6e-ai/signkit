-- SQLite cannot add a composite foreign key to an existing table. Equivalent
-- guards preserve the exact instance/envelope/recipient relationship.
CREATE TRIGGER IF NOT EXISTS delivery_outbox_recipient_scope_insert_guard
BEFORE INSERT ON delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery recipient scope');
END;

CREATE TRIGGER IF NOT EXISTS delivery_outbox_recipient_scope_update_guard
BEFORE UPDATE OF envelope_id, recipient_id ON delivery_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM recipient target
  WHERE target.envelope_id = NEW.envelope_id
    AND target.id = NEW.recipient_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid delivery recipient scope');
END;

-- Force every pre-existing row through the new guard. The trigger creation is
-- idempotent so a non-atomic D1 migration can be repaired and safely retried if
-- historical data violates the invariant; ownership is never guessed.
UPDATE delivery_outbox SET recipient_id = recipient_id;
