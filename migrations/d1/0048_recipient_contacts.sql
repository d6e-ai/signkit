-- Personal recipient contacts. Ownership is the verified d6e-auth subject's
-- active local instance_member row; no organization selector participates.
CREATE TABLE contact (
  id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES instance_member(user_id),
  name TEXT NOT NULL,
  name_search TEXT COLLATE BINARY NOT NULL,
  email TEXT COLLATE BINARY NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en','ja')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_command_hash TEXT NOT NULL,
  CONSTRAINT contact_id_uuidv7 CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7' AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8','9','a','b') AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT contact_name_bound CHECK (length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  CONSTRAINT contact_name_search_bound CHECK (length(name_search) BETWEEN 1 AND 400),
  CONSTRAINT contact_email_bound CHECK (
    length(email) BETWEEN 1 AND 320 AND email = trim(email) AND email = lower(email)
  ),
  CONSTRAINT contact_created_at_iso CHECK (
    length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  CONSTRAINT contact_updated_at_iso CHECK (
    length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at
    AND datetime(updated_at) >= datetime(created_at)
  ),
  CONSTRAINT contact_last_command_hash CHECK (
    length(last_command_hash) = 64 AND last_command_hash NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (owner_user_id, email)
);

CREATE INDEX contact_owner_order ON contact(
  owner_user_id,
  name_search COLLATE BINARY,
  email COLLATE BINARY,
  id COLLATE BINARY
);

-- Mutation receipts deliberately contain no contact name, email, or locale.
CREATE TABLE contact_command (
  actor_id TEXT NOT NULL REFERENCES instance_member(user_id),
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN ('create','update','delete')),
  request_hash TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  expected_version INTEGER,
  result_version INTEGER NOT NULL CHECK (result_version BETWEEN 1 AND 2147483647),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key),
  CONSTRAINT contact_command_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT contact_command_hash CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT contact_command_id_uuidv7 CHECK (
    length(contact_id) = 36 AND substr(contact_id, 9, 1) = '-'
    AND substr(contact_id, 14, 1) = '-' AND substr(contact_id, 15, 1) = '7'
    AND substr(contact_id, 19, 1) = '-' AND substr(contact_id, 20, 1) IN ('8','9','a','b')
    AND substr(contact_id, 24, 1) = '-' AND length(replace(contact_id, '-', '')) = 32
    AND replace(contact_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT contact_command_expected_version CHECK (
    (command_type = 'create' AND expected_version IS NULL AND result_version = 1)
    OR (command_type = 'update' AND expected_version BETWEEN 1 AND 2147483646
        AND result_version = expected_version + 1)
    OR (command_type = 'delete' AND expected_version BETWEEN 1 AND 2147483647
        AND result_version = expected_version)
  ),
  CONSTRAINT contact_command_occurred_at_iso CHECK (
    length(occurred_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at
  )
);

CREATE INDEX contact_command_contact ON contact_command(actor_id, contact_id, command_type);
