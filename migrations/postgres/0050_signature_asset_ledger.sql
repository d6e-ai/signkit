-- PostgreSQL parity for migrations/d1/0054_signature_asset_ledger.sql.
--
-- Provider-neutral retention ledger for a drawn signature/initials asset
-- (`signature-asset.ts`), scoped by the exact (envelope, recipient, sha256)
-- a `sig:sha256:` field value may name. `pending` exists from upload until a
-- signed field value binds it; `bound` is permanent, set the instant a
-- `field_value` names it (`postgres-recipient-sign-store.ts` upserts this
-- inside the same row-locked transaction, and the trigger below enforces it
-- for every other writer); `retired` is a one-way grave
-- marker the orphan sweep commits before it ever deletes the underlying
-- object, so a crash between that commit and the delete is retried from the
-- object listing, and the exact scoped key a delayed delete could still land
-- on is never resurrected by a fresh `pending` registration.
CREATE TABLE signature_asset (
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','bound','retired')),
  created_at timestamptz NOT NULL,
  pending_touched_at timestamptz,
  bound_at timestamptz,
  retired_at timestamptz,
  PRIMARY KEY (envelope_id, recipient_id, sha256),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  -- Exact scoped ownership: the recipient must belong to this envelope.
  FOREIGN KEY (envelope_id, recipient_id) REFERENCES recipient(envelope_id, id),
  CONSTRAINT signature_asset_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT signature_asset_state_timestamps CHECK (
    (state = 'pending' AND pending_touched_at IS NOT NULL AND bound_at IS NULL AND retired_at IS NULL) OR
    (state = 'bound' AND bound_at IS NOT NULL AND retired_at IS NULL) OR
    (state = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE INDEX signature_asset_pending_touched
  ON signature_asset(pending_touched_at)
  WHERE state = 'pending';

-- One-way state machine: the scope never changes, and only `pending` may
-- move (to `bound` or `retired`). `bound` and `retired` rows are final.
CREATE FUNCTION signature_asset_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.envelope_id IS DISTINCT FROM OLD.envelope_id
    OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.state <> 'pending' AND (
      NEW.state IS DISTINCT FROM OLD.state
      OR NEW.pending_touched_at IS DISTINCT FROM OLD.pending_touched_at
      OR NEW.bound_at IS DISTINCT FROM OLD.bound_at
      OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
    ))
  THEN
    RAISE EXCEPTION 'signature asset transition rejected';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signature_asset_transition_guard
BEFORE UPDATE ON signature_asset
FOR EACH ROW EXECUTE FUNCTION signature_asset_guard_transition();

-- Database-enforced binding boundary for every `field_value` writer, matching
-- the D1 trigger: a `sig:sha256:` reference binds its exact scoped row (or
-- grandfathers a missing one in as `bound`), and a `retired` row aborts the
-- whole transaction instead of resurrecting a key the sweep may delete.
CREATE FUNCTION signature_asset_bind_field_value() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  asset_sha256 text;
BEGIN
  IF NEW.field_type NOT IN ('signature', 'initials')
    OR length(NEW.value_json) <> 77
    OR substr(NEW.value_json, 1, 12) <> '"sig:sha256:'
    OR substr(NEW.value_json, 77, 1) <> '"'
  THEN
    RETURN NEW;
  END IF;
  asset_sha256 := substr(NEW.value_json, 13, 64);
  INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, bound_at)
  VALUES (NEW.envelope_id, NEW.recipient_id, asset_sha256, 'bound', NEW.created_at, NEW.created_at)
  ON CONFLICT (envelope_id, recipient_id, sha256) DO UPDATE SET
    state = 'bound', bound_at = EXCLUDED.bound_at, pending_touched_at = NULL
  WHERE signature_asset.state = 'pending';
  IF EXISTS (
    SELECT 1 FROM signature_asset
    WHERE envelope_id = NEW.envelope_id AND recipient_id = NEW.recipient_id
      AND sha256 = asset_sha256 AND state = 'retired'
  ) THEN
    RAISE EXCEPTION 'signature asset retired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER field_value_bind_signature_asset
AFTER INSERT ON field_value
FOR EACH ROW EXECUTE FUNCTION signature_asset_bind_field_value();

-- Backfill: every signature/initials field value ever signed before this
-- ledger existed is grandfathered in as bound, exact scope and hash, so the
-- new retirement path never contests an asset the field_value reference
-- check alone already proved live.
INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, bound_at)
SELECT envelope_id, recipient_id, substr(value_json, 13, 64), 'bound', created_at, created_at
FROM field_value
WHERE field_type IN ('signature', 'initials')
  AND length(value_json) = 77
  AND substr(value_json, 1, 12) = '"sig:sha256:'
  AND substr(value_json, 77, 1) = '"'
ON CONFLICT (envelope_id, recipient_id, sha256) DO NOTHING;
