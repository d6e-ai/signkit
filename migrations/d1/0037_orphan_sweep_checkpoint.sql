-- Durable resume key for the bounded object-store orphan sweep.
-- Callers cannot supply this value; only the worker updates it after a
-- successful scan so later runs can walk past a first page of live objects.
CREATE TABLE orphan_sweep_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_object_key TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT INTO orphan_sweep_checkpoint (singleton, last_object_key, updated_at)
VALUES (1, '', '1970-01-01T00:00:00.000Z');
