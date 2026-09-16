-- Personal recipient contacts, owned only by an active local instance member.
CREATE TABLE contact (
  id text COLLATE "C" NOT NULL PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES instance_member(user_id),
  name text NOT NULL,
  name_search text COLLATE "C" NOT NULL,
  email text COLLATE "C" NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en','ja')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_command_hash text NOT NULL,
  CONSTRAINT contact_id_uuidv7 CHECK (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT contact_name_bound CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name)),
  CONSTRAINT contact_name_search_bound CHECK (char_length(name_search) BETWEEN 1 AND 200),
  CONSTRAINT contact_email_bound CHECK (
    char_length(email) BETWEEN 1 AND 320 AND email = btrim(email) AND email = lower(email)
  ),
  CONSTRAINT contact_updated_at_order CHECK (updated_at >= created_at),
  CONSTRAINT contact_last_command_hash CHECK (last_command_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (owner_user_id, email)
);

CREATE INDEX contact_owner_order ON contact(
  owner_user_id,
  name_search COLLATE "C",
  email COLLATE "C",
  id COLLATE "C"
);

-- Mutation receipts deliberately contain no contact name, email, or locale.
CREATE TABLE contact_command (
  actor_id text NOT NULL REFERENCES instance_member(user_id),
  idempotency_key text NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('create','update','delete')),
  request_hash text NOT NULL,
  contact_id text NOT NULL,
  expected_version integer,
  result_version integer NOT NULL CHECK (result_version BETWEEN 1 AND 2147483647),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key),
  CONSTRAINT contact_command_idempotency_bound CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key ~ '^[\x21-\x7E]+$'
  ),
  CONSTRAINT contact_command_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contact_command_id_uuidv7 CHECK (
    contact_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT contact_command_expected_version CHECK (
    (command_type = 'create' AND expected_version IS NULL AND result_version = 1)
    OR (command_type = 'update' AND expected_version BETWEEN 1 AND 2147483646
        AND result_version = expected_version + 1)
    OR (command_type = 'delete' AND expected_version BETWEEN 1 AND 2147483647
        AND result_version = expected_version)
  )
);

CREATE INDEX contact_command_contact ON contact_command(actor_id, contact_id, command_type);
