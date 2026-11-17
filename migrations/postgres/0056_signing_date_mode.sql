-- Optional server-owned automatic signing dates on the existing `date` field
-- type. `date_mode = 'signed_at'` freezes an IANA `date_time_zone` at placement
-- and the server fills the value from the exact signing instant. Both columns
-- stay NULL for every manual/historical field, so this forward-only migration
-- is purely additive and leaves FKs, indexes and triggers untouched.
ALTER TABLE envelope_field
  ADD COLUMN date_mode text NULL,
  ADD COLUMN date_time_zone text NULL,
  ADD CONSTRAINT envelope_field_date_mode_shape CHECK (
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
CREATE FUNCTION envelope_field_guard_date_options() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.date_mode IS DISTINCT FROM OLD.date_mode
    OR NEW.date_time_zone IS DISTINCT FROM OLD.date_time_zone
  THEN
    RAISE EXCEPTION 'envelope field date options are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER envelope_field_date_options_immutable
BEFORE UPDATE ON envelope_field
FOR EACH ROW EXECUTE FUNCTION envelope_field_guard_date_options();

-- Database guard for every field_value writer: an automatic date value must be
-- a real calendar date within one day of the signing instant (the widest
-- possible zone offset difference), never client-chosen free text.
CREATE FUNCTION field_value_guard_automatic_date() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  value_date date;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM envelope_field field
    WHERE field.id = NEW.field_id
      AND field.envelope_id = NEW.envelope_id
      AND field.date_mode = 'signed_at'
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.field_type <> 'date' OR NEW.value_json !~ '^"[0-9]{4}-[0-9]{2}-[0-9]{2}"$' THEN
    RAISE EXCEPTION 'automatic date value invalid';
  END IF;
  BEGIN
    value_date := substr(NEW.value_json, 2, 10)::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'automatic date value invalid';
  END;
  IF to_char(value_date, 'YYYY-MM-DD') <> substr(NEW.value_json, 2, 10)
    OR value_date < ((NEW.created_at AT TIME ZONE 'UTC')::date - 1)
    OR value_date > ((NEW.created_at AT TIME ZONE 'UTC')::date + 1)
  THEN
    RAISE EXCEPTION 'automatic date value invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER field_value_automatic_date_guard
BEFORE INSERT ON field_value
FOR EACH ROW EXECUTE FUNCTION field_value_guard_automatic_date();
