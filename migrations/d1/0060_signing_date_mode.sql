-- Optional server-owned automatic signing dates on the existing `date` field
-- type. `date_mode = 'signed_at'` freezes an IANA `date_time_zone` at placement
-- and the server fills the value from the exact signing instant. Both columns
-- stay NULL for every manual/historical field, so this forward-only migration
-- is purely additive: no table rebuild, so the field_value -> envelope_field
-- composite FK, existing indexes and triggers are untouched.
ALTER TABLE envelope_field ADD COLUMN date_mode TEXT NULL
  CHECK (date_mode IS NULL OR date_mode = 'signed_at');
ALTER TABLE envelope_field ADD COLUMN date_time_zone TEXT NULL
  CHECK (
    (date_mode IS NULL AND date_time_zone IS NULL)
    OR (
      date_mode IS NOT NULL
      AND date_mode = 'signed_at'
      AND field_type = 'date'
      AND date_time_zone IS NOT NULL
      AND length(date_time_zone) BETWEEN 1 AND 64
    )
  );

-- Automatic options are frozen with the placement: replacing a field set is a
-- DELETE + INSERT, so any in-place change to the options is tampering.
CREATE TRIGGER envelope_field_date_options_immutable
BEFORE UPDATE OF date_mode, date_time_zone ON envelope_field
FOR EACH ROW
WHEN OLD.date_mode IS NOT NEW.date_mode OR OLD.date_time_zone IS NOT NEW.date_time_zone
BEGIN
  SELECT RAISE(ABORT, 'envelope field date options are immutable');
END;

-- Database guard for every field_value writer: an automatic date value must be
-- a real calendar date within one day of the signing instant (the widest
-- possible zone offset difference), never client-chosen free text.
CREATE TRIGGER field_value_automatic_date_guard
BEFORE INSERT ON field_value
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM envelope_field field
  WHERE field.id = NEW.field_id
    AND field.envelope_id = NEW.envelope_id
    AND field.date_mode = 'signed_at'
)
BEGIN
  SELECT RAISE(ABORT, 'automatic date value invalid')
  WHERE NEW.field_type <> 'date'
    OR NEW.value_json NOT GLOB '"[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"'
    OR date(substr(NEW.value_json, 2, 10)) IS NOT substr(NEW.value_json, 2, 10)
    OR julianday(substr(NEW.value_json, 2, 10)) < julianday(date(NEW.created_at), '-1 day')
    OR julianday(substr(NEW.value_json, 2, 10)) > julianday(date(NEW.created_at), '+1 day');
END;
