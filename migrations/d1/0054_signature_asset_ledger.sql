-- Provider-neutral retention ledger for a drawn signature/initials asset
-- (`signature-asset.ts`), scoped by the exact (envelope, recipient, sha256)
-- a `sig:sha256:` field value may name. `pending` exists from upload until a
-- signed field value binds it; `bound` is permanent, set by the trigger
-- below the instant `field_value` names it; `retired` is a one-way grave
-- marker the orphan sweep commits before it ever deletes the underlying
-- object, so a crash between that commit and the delete is retried from the
-- object listing, and the exact scoped key a delayed delete could still land
-- on is never resurrected by a fresh `pending` registration.
CREATE TABLE signature_asset (
  envelope_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','bound','retired')),
  created_at TEXT NOT NULL,
  pending_touched_at TEXT,
  bound_at TEXT,
  retired_at TEXT,
  PRIMARY KEY (envelope_id, recipient_id, sha256),
  FOREIGN KEY (envelope_id) REFERENCES envelope(id),
  FOREIGN KEY (recipient_id) REFERENCES recipient(id),
  CONSTRAINT signature_asset_sha256_hex CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (state = 'pending' AND pending_touched_at IS NOT NULL AND bound_at IS NULL AND retired_at IS NULL) OR
    (state = 'bound' AND bound_at IS NOT NULL AND retired_at IS NULL) OR
    (state = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE INDEX signature_asset_pending_touched
  ON signature_asset(pending_touched_at)
  WHERE state = 'pending';

-- Exact scoped ownership: a ledger row may only name a recipient that belongs
-- to the same envelope, mirroring the PostgreSQL composite foreign key.
CREATE TRIGGER signature_asset_scoped_owner
BEFORE INSERT ON signature_asset
WHEN NOT EXISTS (
  SELECT 1 FROM recipient
  WHERE id = NEW.recipient_id AND envelope_id = NEW.envelope_id
)
BEGIN
  SELECT RAISE(ABORT, 'signature asset owner mismatch');
END;

-- One-way state machine: the scope never changes, and only `pending` may
-- move (to `bound` or `retired`). `bound` and `retired` rows are final.
CREATE TRIGGER signature_asset_transition_guard
BEFORE UPDATE ON signature_asset
WHEN NEW.envelope_id IS NOT OLD.envelope_id
  OR NEW.recipient_id IS NOT OLD.recipient_id
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state <> 'pending' AND (
    NEW.state IS NOT OLD.state
    OR NEW.pending_touched_at IS NOT OLD.pending_touched_at
    OR NEW.bound_at IS NOT OLD.bound_at
    OR NEW.retired_at IS NOT OLD.retired_at
  ))
BEGIN
  SELECT RAISE(ABORT, 'signature asset transition rejected');
END;

-- The sole D1 binding boundary: the instant a signed field value names a
-- `sig:sha256:` reference, this upserts its ledger row to `bound`, grandfathering
-- in a reference with no prior `pending` row (a legacy signature signed before
-- this ledger existed, or a registration gap). A `retired` row aborts the whole
-- recipient-signed batch instead -- the orphan sweep already committed to
-- collecting that exact scoped key, and this insert must not resurrect it. An
-- already `bound` row (the same drawing used for signature and initials) is
-- left untouched.
CREATE TRIGGER field_value_bind_signature_asset
AFTER INSERT ON field_value
WHEN NEW.field_type IN ('signature', 'initials')
  AND length(NEW.value_json) = 77
  AND substr(NEW.value_json, 1, 12) = '"sig:sha256:'
  AND substr(NEW.value_json, 77, 1) = '"'
BEGIN
  SELECT (CASE
    WHEN EXISTS (
      SELECT 1 FROM signature_asset
      WHERE envelope_id = NEW.envelope_id AND recipient_id = NEW.recipient_id
        AND sha256 = substr(NEW.value_json, 13, 64) AND state = 'retired'
    ) THEN RAISE(ABORT, 'signature asset retired')
  END);

  INSERT INTO signature_asset (
    envelope_id, recipient_id, sha256, state, created_at, bound_at
  ) VALUES (
    NEW.envelope_id, NEW.recipient_id, substr(NEW.value_json, 13, 64),
    'bound', NEW.created_at, NEW.created_at
  )
  ON CONFLICT (envelope_id, recipient_id, sha256) DO UPDATE SET
    state = 'bound', bound_at = NEW.created_at, pending_touched_at = NULL
  WHERE signature_asset.state = 'pending';
END;

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
