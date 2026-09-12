-- One-time instance bootstrap record. One database equals one SignKit instance.
-- The singleton row records the initial instance owner and bootstrap timestamp.
-- It references instance_member(user_id) and stores no secret-derived material.
CREATE TABLE instance_bootstrap (
  singleton_key INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton_key = 1),
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES instance_member(user_id),
  CONSTRAINT instance_bootstrap_owner_bound CHECK (
    length(owner_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_bootstrap_created_at_iso CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(created_at) IS NOT NULL
  )
);

-- Durable bootstrap command receipt keyed by actor and Idempotency-Key.
-- Exact replay after response loss is already-bootstrapped evidence.
CREATE TABLE instance_bootstrap_command (
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, idempotency_key),
  FOREIGN KEY (actor_id) REFERENCES instance_member(user_id),
  FOREIGN KEY (owner_user_id) REFERENCES instance_member(user_id),
  CONSTRAINT instance_bootstrap_command_actor_bound CHECK (
    length(actor_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_bootstrap_command_idempotency_bound CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  CONSTRAINT instance_bootstrap_command_request_hash_sha256 CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT instance_bootstrap_command_owner_bound CHECK (
    length(owner_user_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT instance_bootstrap_command_created_at_iso CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND datetime(created_at) IS NOT NULL
  )
);
