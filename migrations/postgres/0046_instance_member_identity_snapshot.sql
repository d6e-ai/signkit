-- Display-only identity snapshots copied from the member's verified d6e-auth
-- principal. Authorization continues to depend exclusively on user_id, role,
-- and status; these nullable fields may be stale and must never grant access.
ALTER TABLE instance_member
  ADD COLUMN display_name text,
  ADD COLUMN email text,
  ADD CONSTRAINT instance_member_display_name_bound CHECK (
    display_name IS NULL OR (
      char_length(display_name) BETWEEN 1 AND 200
      AND display_name = btrim(display_name)
    )
  ),
  ADD CONSTRAINT instance_member_email_bound CHECK (
    email IS NULL OR (
      char_length(email) BETWEEN 3 AND 320
      AND email = btrim(email)
      AND email = lower(email)
      AND position('@' IN email) > 1
    )
  );
