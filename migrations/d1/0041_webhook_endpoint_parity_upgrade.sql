-- Hardened invariants and atomic active cap guards for webhook endpoints.
-- This migration brings databases that previously applied 0030 to parity
-- with PostgreSQL and fresh D1 installations, while preserving existing
-- rows, foreign keys, indexes, and triggers.

-- 1. Validate that any existing rows satisfy the hardened invariants.
SELECT (CASE
  WHEN EXISTS (
    SELECT 1 FROM webhook_endpoint
    WHERE length(secret_hash) <> 64
      OR secret_hash GLOB '*[^0-9a-f]*'
      OR length(signing_secret) < 20
      OR length(signing_secret) > 200
      OR length(secret_prefix) < 1
      OR length(secret_prefix) > 32
  )
  THEN json('existing webhook_endpoint rows violate constraints')
  WHEN EXISTS (
    SELECT 1 FROM webhook_endpoint_command
    WHERE length(request_hash) <> 64
      OR request_hash GLOB '*[^0-9a-f]*'
  )
  THEN json('existing webhook_endpoint_command rows violate constraints')
  WHEN EXISTS (
    SELECT 1 FROM webhook_endpoint
    WHERE status = 'active'
    GROUP BY organization_id
    HAVING COUNT(*) > 20
  )
  THEN json('existing organization exceeds active webhook endpoint limit')
  ELSE 1
END);

-- 2. Cap guard triggers (atomic enforcement of max 20 active endpoints per organization).
DROP TRIGGER IF EXISTS webhook_endpoint_active_cap_guard;
CREATE TRIGGER webhook_endpoint_active_cap_guard
BEFORE INSERT ON webhook_endpoint
WHEN NEW.status = 'active'
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*)
      FROM webhook_endpoint
      WHERE organization_id = NEW.organization_id
        AND status = 'active'
    ) >= 20
    THEN RAISE(ABORT, 'organization active webhook endpoint limit exceeded')
  END);
END;

DROP TRIGGER IF EXISTS webhook_endpoint_active_cap_update_guard;
CREATE TRIGGER webhook_endpoint_active_cap_update_guard
BEFORE UPDATE OF status ON webhook_endpoint
WHEN NEW.status = 'active' AND OLD.status <> 'active'
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*)
      FROM webhook_endpoint
      WHERE organization_id = NEW.organization_id
        AND status = 'active'
    ) >= 20
    THEN RAISE(ABORT, 'organization active webhook endpoint limit exceeded')
  END);
END;

-- 3. Validation triggers on webhook_endpoint for upgraded databases.
DROP TRIGGER IF EXISTS webhook_endpoint_validate_insert_guard;
CREATE TRIGGER webhook_endpoint_validate_insert_guard
BEFORE INSERT ON webhook_endpoint
BEGIN
  SELECT (CASE
    WHEN length(NEW.secret_hash) <> 64
      OR NEW.secret_hash GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_secret_hash_sha256')
    WHEN length(NEW.signing_secret) < 20
      OR length(NEW.signing_secret) > 200
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_signing_secret_bound')
    WHEN length(NEW.secret_prefix) < 1
      OR length(NEW.secret_prefix) > 32
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_secret_prefix_bound')
  END);
END;

DROP TRIGGER IF EXISTS webhook_endpoint_validate_update_guard;
CREATE TRIGGER webhook_endpoint_validate_update_guard
BEFORE UPDATE ON webhook_endpoint
BEGIN
  SELECT (CASE
    WHEN length(NEW.secret_hash) <> 64
      OR NEW.secret_hash GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_secret_hash_sha256')
    WHEN length(NEW.signing_secret) < 20
      OR length(NEW.signing_secret) > 200
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_signing_secret_bound')
    WHEN length(NEW.secret_prefix) < 1
      OR length(NEW.secret_prefix) > 32
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_secret_prefix_bound')
  END);
END;

-- 4. Validation triggers on webhook_endpoint_command for upgraded databases.
DROP TRIGGER IF EXISTS webhook_endpoint_command_validate_insert_guard;
CREATE TRIGGER webhook_endpoint_command_validate_insert_guard
BEFORE INSERT ON webhook_endpoint_command
BEGIN
  SELECT (CASE
    WHEN length(NEW.request_hash) <> 64
      OR NEW.request_hash GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_command_request_hash_sha256')
  END);
END;

DROP TRIGGER IF EXISTS webhook_endpoint_command_validate_update_guard;
CREATE TRIGGER webhook_endpoint_command_validate_update_guard
BEFORE UPDATE ON webhook_endpoint_command
BEGIN
  SELECT (CASE
    WHEN length(NEW.request_hash) <> 64
      OR NEW.request_hash GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'CHECK constraint failed: webhook_endpoint_command_request_hash_sha256')
  END);
END;
