-- Optional normalized page/x/y/width/height geometry for a signing field, in
-- addition to the semantic document-order `position` this table already
-- tracks. Coordinates are unit-square fractions of one rendered page (0..1),
-- resolution- and zoom-independent by construction. All columns stay
-- nullable: a field with no geometry keeps its existing document-order-only
-- meaning, so this migration is purely additive.
ALTER TABLE envelope_field
  ADD COLUMN page integer NULL CHECK (page IS NULL OR page BETWEEN 1 AND 100000),
  ADD COLUMN x real NULL CHECK (x IS NULL OR (x >= 0 AND x <= 1)),
  ADD COLUMN y real NULL CHECK (y IS NULL OR (y >= 0 AND y <= 1)),
  ADD COLUMN width real NULL CHECK (width IS NULL OR (width > 0 AND width <= 1)),
  ADD COLUMN height real NULL CHECK (height IS NULL OR (height > 0 AND height <= 1)),
  ADD CONSTRAINT envelope_field_geometry_complete CHECK (
    (page IS NULL AND x IS NULL AND y IS NULL AND width IS NULL AND height IS NULL)
    OR (page IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL)
  );
