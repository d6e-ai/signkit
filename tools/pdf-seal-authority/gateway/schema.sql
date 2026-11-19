-- Standalone D1 schema for the managed key gateway (issue #285).
-- Apply only to the provider-owned LEDGER database; never to the SignKit app database
-- and never from the app migration directory. Admission rows are permanent and immutable.
CREATE TABLE IF NOT EXISTS provider_signing_replay (
	issuer TEXT NOT NULL CHECK (issuer <> ''),
	audience TEXT NOT NULL CHECK (audience <> ''),
	envelope_id TEXT NOT NULL CHECK (envelope_id <> ''),
	operation_id TEXT NOT NULL CHECK (operation_id <> ''),
	authorization_sha256 TEXT NOT NULL
		CHECK (length(authorization_sha256) = 64 AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'),
	accepted_at TEXT NOT NULL,
	expires_at TEXT NOT NULL CHECK (expires_at > accepted_at),
	PRIMARY KEY (issuer, audience, operation_id),
	UNIQUE (issuer, audience, envelope_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS provider_signing_replay_no_update
	BEFORE UPDATE ON provider_signing_replay
BEGIN
	SELECT RAISE(ABORT, 'provider_signing_replay rows are permanent and immutable');
END;

CREATE TRIGGER IF NOT EXISTS provider_signing_replay_no_delete
	BEFORE DELETE ON provider_signing_replay
BEGIN
	SELECT RAISE(ABORT, 'provider_signing_replay rows are permanent and immutable');
END;

-- One receipt per admitted operation. Only status and result columns may change, and only
-- forward: pending -> processing -> succeeded | failed. The HSM request id is audit-only.
CREATE TABLE IF NOT EXISTS provider_signing_receipt (
	issuer TEXT NOT NULL,
	audience TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	envelope_id TEXT NOT NULL,
	receipt_id TEXT NOT NULL UNIQUE,
	source_sha256 TEXT NOT NULL,
	source_byte_size INTEGER NOT NULL CHECK (source_byte_size > 0),
	requested_profile TEXT NOT NULL CHECK (requested_profile = 'pades-b-b'),
	signer_certificate_sha256 TEXT NOT NULL,
	seal_policy_id TEXT NOT NULL,
	validation_policy_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
	error_code TEXT,
	result_sha256 TEXT,
	result_byte_size INTEGER,
	engine_request_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (issuer, audience, operation_id),
	CHECK ((status = 'succeeded') = (result_sha256 IS NOT NULL AND result_byte_size IS NOT NULL)),
	CHECK ((status = 'failed') = (error_code IS NOT NULL))
) STRICT;

CREATE TRIGGER IF NOT EXISTS provider_signing_receipt_guard
	BEFORE UPDATE ON provider_signing_receipt
	WHEN NEW.issuer <> OLD.issuer OR NEW.audience <> OLD.audience
		OR NEW.operation_id <> OLD.operation_id OR NEW.envelope_id <> OLD.envelope_id
		OR NEW.receipt_id <> OLD.receipt_id OR NEW.source_sha256 <> OLD.source_sha256
		OR NEW.source_byte_size <> OLD.source_byte_size
		OR NEW.requested_profile <> OLD.requested_profile
		OR NEW.signer_certificate_sha256 <> OLD.signer_certificate_sha256
		OR NEW.seal_policy_id <> OLD.seal_policy_id
		OR NEW.validation_policy_id <> OLD.validation_policy_id
		OR NEW.created_at <> OLD.created_at
		OR NOT ((OLD.status = 'pending' AND NEW.status = 'processing')
			OR (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed')))
BEGIN
	SELECT RAISE(ABORT, 'provider_signing_receipt transition is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS provider_signing_receipt_no_delete
	BEFORE DELETE ON provider_signing_receipt
BEGIN
	SELECT RAISE(ABORT, 'provider_signing_receipt rows are permanent');
END;
