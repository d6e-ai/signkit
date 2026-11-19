import type postgres from 'postgres';

export type ProviderSigningReservation = {
	readonly issuer: string;
	readonly audience: string;
	readonly envelopeId: string;
	readonly operationId: string;
	readonly authorizationSha256: string;
	/** Informational only; deliberately not part of exact replay matching. */
	readonly acceptedAt: string;
};

export type ProviderSigningReserveResult = 'reserved' | 'existing' | 'conflict';

type StoredReservation = { envelope_id: string; authorization_sha256: string };

/**
 * Permanent pre-key-use reservation ledger. Uses a dedicated service-owned connection;
 * the schema lives in tools/pdf-seal-authority/postgres-schema.sql. Does no I/O besides
 * the database and never retries: an ambiguous failure propagates to the caller.
 */
export class PostgresProviderSigningReplay {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async reserve(input: ProviderSigningReservation): Promise<ProviderSigningReserveResult> {
		// No conflict target: either uniqueness constraint (operation or envelope) suppresses the insert.
		const inserted = await this.#sql`
			INSERT INTO provider_signing_replay
				(issuer, audience, envelope_id, operation_id, authorization_sha256, accepted_at)
			VALUES (${input.issuer}, ${input.audience}, ${input.envelopeId}, ${input.operationId},
				${input.authorizationSha256}, ${input.acceptedAt}::timestamptz)
			ON CONFLICT DO NOTHING
			RETURNING operation_id
		`;
		if (inserted.length === 1) return 'reserved';
		// Separate statement: under read committed it sees the committed winner of a concurrent insert.
		const rows = await this.#sql<StoredReservation[]>`
			SELECT envelope_id, authorization_sha256
			FROM provider_signing_replay
			WHERE issuer = ${input.issuer} AND audience = ${input.audience}
				AND operation_id = ${input.operationId}
		`;
		const existing: StoredReservation | undefined = rows[0];
		if (
			existing !== undefined &&
			existing.envelope_id === input.envelopeId &&
			existing.authorization_sha256 === input.authorizationSha256
		) {
			return 'existing';
		}
		// Different operation/hash for this operation, or the envelope's single key use is taken.
		return 'conflict';
	}
}
