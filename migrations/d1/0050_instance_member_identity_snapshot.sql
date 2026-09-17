-- Display-only identity snapshots copied from the member's verified d6e-auth
-- principal. Authorization continues to depend exclusively on user_id, role,
-- and status; these nullable fields may be stale and must never grant access.
ALTER TABLE instance_member ADD COLUMN display_name TEXT
  CONSTRAINT instance_member_display_name_bound CHECK (
    display_name IS NULL OR (
      length(display_name) BETWEEN 1 AND 200
      AND display_name = trim(display_name)
    )
  );

ALTER TABLE instance_member ADD COLUMN email TEXT
  CONSTRAINT instance_member_email_bound CHECK (
    email IS NULL OR (
      length(email) BETWEEN 3 AND 320
      AND email = trim(email)
      AND email = lower(email)
      AND instr(email, '@') > 1
    )
  );
