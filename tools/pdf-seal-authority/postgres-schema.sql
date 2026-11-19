-- Standalone schema for the PDF seal authority's replay ledger (issue #285).
-- Apply only to the signing service's own database; never to the SignKit app database
-- and never from the production app migration directory. Rows are permanent and immutable.
CREATE TABLE IF NOT EXISTS provider_signing_replay (
	issuer text NOT NULL CHECK (issuer <> ''),
	audience text NOT NULL CHECK (audience <> ''),
	envelope_id text NOT NULL CHECK (envelope_id <> ''),
	operation_id text NOT NULL CHECK (operation_id <> ''),
	authorization_sha256 text NOT NULL CHECK (authorization_sha256 ~ '^[0-9a-f]{64}$'),
	accepted_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL CHECK (expires_at > accepted_at),
	PRIMARY KEY (issuer, audience, operation_id),
	UNIQUE (issuer, audience, envelope_id)
);

CREATE OR REPLACE FUNCTION provider_signing_replay_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'provider_signing_replay rows are permanent and immutable';
END;
$$;

DROP TRIGGER IF EXISTS provider_signing_replay_immutable ON provider_signing_replay;
CREATE TRIGGER provider_signing_replay_immutable
	BEFORE UPDATE OR DELETE ON provider_signing_replay
	FOR EACH ROW EXECUTE FUNCTION provider_signing_replay_immutable();

DROP TRIGGER IF EXISTS provider_signing_replay_no_truncate ON provider_signing_replay;
CREATE TRIGGER provider_signing_replay_no_truncate
	BEFORE TRUNCATE ON provider_signing_replay
	FOR EACH STATEMENT EXECUTE FUNCTION provider_signing_replay_immutable();
