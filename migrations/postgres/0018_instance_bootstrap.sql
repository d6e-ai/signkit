-- One-time instance bootstrap record. One database equals one SignKit instance.
-- The singleton row records the initial instance owner and bootstrap timestamp.
-- It references instance_member(user_id) and stores no secret-derived material.
CREATE TABLE instance_bootstrap (
  singleton_key integer PRIMARY KEY DEFAULT 1 CHECK (singleton_key = 1),
  owner_user_id text NOT NULL REFERENCES instance_member(user_id),
  created_at timestamptz NOT NULL,
  CONSTRAINT instance_bootstrap_owner_bound CHECK (
    char_length(owner_user_id) BETWEEN 1 AND 200
  )
);

-- Durable bootstrap command receipt keyed by actor and Idempotency-Key.
-- Exact replay after response loss is already-bootstrapped evidence.
CREATE TABLE instance_bootstrap_command (
  actor_type text NOT NULL CHECK (actor_type = 'user'),
  actor_id text NOT NULL REFERENCES instance_member(user_id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  owner_user_id text NOT NULL REFERENCES instance_member(user_id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  CONSTRAINT instance_bootstrap_command_actor_bound CHECK (
    char_length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_bootstrap_command_idempotency_bound CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key ~ '^[\x21-\x7E]+$'
  ),
  CONSTRAINT instance_bootstrap_command_request_hash_sha256 CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT instance_bootstrap_command_owner_bound CHECK (
    char_length(owner_user_id) BETWEEN 1 AND 200
  )
);
