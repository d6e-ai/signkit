-- Optional normalized page/x/y/width/height geometry for a signing field, in
-- addition to the semantic document-order `position` this table already
-- tracks. Coordinates are unit-square fractions of one rendered page (0..1),
-- resolution- and zoom-independent by construction. All columns stay
-- nullable: a field with no geometry keeps its existing document-order-only
-- meaning, so this migration is purely additive. SQLite has no table-level
-- ADD CONSTRAINT, so the application layer enforces the all-or-nothing rule
-- that PostgreSQL enforces with `envelope_field_geometry_complete`.
ALTER TABLE envelope_field ADD COLUMN page INTEGER NULL
  CHECK (page IS NULL OR page BETWEEN 1 AND 100000);
ALTER TABLE envelope_field ADD COLUMN x REAL NULL
  CHECK (x IS NULL OR (x >= 0 AND x <= 1));
ALTER TABLE envelope_field ADD COLUMN y REAL NULL
  CHECK (y IS NULL OR (y >= 0 AND y <= 1));
ALTER TABLE envelope_field ADD COLUMN width REAL NULL
  CHECK (width IS NULL OR (width > 0 AND width <= 1));
ALTER TABLE envelope_field ADD COLUMN height REAL NULL
  CHECK (height IS NULL OR (height > 0 AND height <= 1));
