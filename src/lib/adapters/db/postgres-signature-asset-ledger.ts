import postgres from 'postgres';
import type {
	RegisterSignatureAssetResult,
	SignatureAssetFreshnessResult,
	SignatureAssetLedger,
	SignatureAssetScope,
	SignatureAssetState
} from '$lib/ports/signature-asset-ledger';
import { assertSignatureLedgerBatch } from '$lib/ports/signature-asset-ledger';

const PENDING: SignatureAssetState = `pending`;
const BOUND: SignatureAssetState = `bound`;
const RETIRED: SignatureAssetState = `retired`;

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

export class PostgresSignatureAssetLedger implements SignatureAssetLedger {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async registerPending(
		scope: SignatureAssetScope,
		now: string
	): Promise<RegisterSignatureAssetResult> {
		await this.#sql`
			INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, pending_touched_at)
			VALUES (${scope.envelopeId}, ${scope.recipientId}, ${scope.sha256}, ${PENDING}, ${now}::timestamptz, ${now}::timestamptz)
			ON CONFLICT (envelope_id, recipient_id, sha256) DO UPDATE SET pending_touched_at = EXCLUDED.pending_touched_at
			WHERE signature_asset.state = ${PENDING}
		`;
		const state: SignatureAssetState | null = await this.readState(scope);
		if (state === RETIRED) return 'retired';
		return `ok`;
	}

	async checkFresh(
		scope: SignatureAssetScope,
		now: string
	): Promise<SignatureAssetFreshnessResult> {
		await this.#sql`
			UPDATE signature_asset SET pending_touched_at = ${now}::timestamptz
			WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
				AND sha256 = ${scope.sha256} AND state = ${PENDING}
		`;
		const state: SignatureAssetState | null = await this.readState(scope);
		if (state === null) return `missing`;
		return state;
	}

	async retireOrphans(
		scopes: readonly SignatureAssetScope[],
		now: string,
		touchedBefore: string
	): Promise<readonly SignatureAssetState[]> {
		assertSignatureLedgerBatch(scopes);
		if (scopes.length === 0) return [];
		// A deterministic order keeps concurrent sweeps from deadlocking on locks.
		const { e, r, h } = scopeArrays([...scopes].sort(compareScopes));
		const states: Map<string, SignatureAssetState> = await this.#sql.begin(
			async (transaction: postgres.TransactionSql): Promise<Map<string, SignatureAssetState>> => {
				// Lock existing scoped rows first so a concurrent recipient-signed
				// transaction's bind either already committed (seen as bound
				// below) or waits until this retirement commits (then fails closed).
				await transaction`
					SELECT 1 FROM signature_asset AS asset
					INNER JOIN unnest(${e}::text[], ${r}::text[], ${h}::text[]) AS candidate(e, r, h)
						ON asset.envelope_id = candidate.e AND asset.recipient_id = candidate.r
						AND asset.sha256 = candidate.h
					ORDER BY asset.envelope_id, asset.recipient_id, asset.sha256
					FOR UPDATE OF asset
				`;
				// Legacy, pre-ledger objects (their recipient may no longer exist:
				// a tombstone needs no live owner, a bound row does). An existing
				// or concurrently inserted scope makes its row DO NOTHING; the
				// guarded update and re-read below then decide it.
				await transaction`
					INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, bound_at, retired_at)
					SELECT candidate.e, candidate.r, candidate.h,
						CASE WHEN reference.live THEN ${BOUND} ELSE ${RETIRED} END,
						${now}::timestamptz,
						CASE WHEN reference.live THEN ${now}::timestamptz END,
						CASE WHEN reference.live THEN NULL ELSE ${now}::timestamptz END
					FROM unnest(${e}::text[], ${r}::text[], ${h}::text[]) WITH ORDINALITY
						AS candidate(e, r, h, position)
					CROSS JOIN LATERAL (
						SELECT EXISTS (
							SELECT 1 FROM field_value
							WHERE envelope_id = candidate.e AND recipient_id = candidate.r
								AND field_type IN ('signature', 'initials')
								AND value_json = '"sig:sha256:' || candidate.h || '"'
						) AS live
					) reference
					ORDER BY candidate.position
					ON CONFLICT (envelope_id, recipient_id, sha256) DO NOTHING
				`;
				await transaction`
					UPDATE signature_asset AS asset
					SET state = ${RETIRED}, retired_at = ${now}::timestamptz, pending_touched_at = NULL
					FROM unnest(${e}::text[], ${r}::text[], ${h}::text[]) AS candidate(e, r, h)
					WHERE asset.envelope_id = candidate.e AND asset.recipient_id = candidate.r
						AND asset.sha256 = candidate.h AND asset.state = ${PENDING}
						AND asset.pending_touched_at <= ${touchedBefore}::timestamptz
						AND NOT EXISTS (
							SELECT 1 FROM field_value
							WHERE envelope_id = asset.envelope_id AND recipient_id = asset.recipient_id
								AND field_type IN ('signature', 'initials')
								AND value_json = '"sig:sha256:' || asset.sha256 || '"'
						)
				`;
				const rows = await transaction<
					{ envelopeId: string; recipientId: string; sha256: string; state: SignatureAssetState }[]
				>`
					SELECT asset.envelope_id AS "envelopeId", asset.recipient_id AS "recipientId",
						asset.sha256, asset.state
					FROM signature_asset AS asset
					INNER JOIN unnest(${e}::text[], ${r}::text[], ${h}::text[]) AS candidate(e, r, h)
						ON asset.envelope_id = candidate.e AND asset.recipient_id = candidate.r
						AND asset.sha256 = candidate.h
				`;
				return new Map(
					rows.map((row): [string, SignatureAssetState] => [scopeKey(row), row.state])
				);
			}
		);
		return scopes.map((scope: SignatureAssetScope): SignatureAssetState => {
			const state: SignatureAssetState | undefined = states.get(scopeKey(scope));
			if (state === undefined) throw new Error('signature asset retirement left no ledger row');
			return state;
		});
	}

	async previewRetirements(
		scopes: readonly SignatureAssetScope[],
		touchedBefore: string
	): Promise<readonly boolean[]> {
		assertSignatureLedgerBatch(scopes);
		if (scopes.length === 0) return [];
		const { e, r, h } = scopeArrays(scopes);
		const rows = await this.#sql<{ position: string; retirable: boolean }[]>`
			SELECT candidate.position::text AS position, CASE
				WHEN asset.state = ${RETIRED} THEN true
				WHEN asset.state = ${BOUND} THEN false
				WHEN EXISTS (
					SELECT 1 FROM field_value
					WHERE envelope_id = candidate.e AND recipient_id = candidate.r
						AND field_type IN ('signature', 'initials')
						AND value_json = '"sig:sha256:' || candidate.h || '"'
				) THEN false
				WHEN asset.state IS NULL THEN true
				ELSE asset.pending_touched_at <= ${touchedBefore}::timestamptz
			END AS retirable
			FROM unnest(${e}::text[], ${r}::text[], ${h}::text[]) WITH ORDINALITY
				AS candidate(e, r, h, position)
			LEFT JOIN signature_asset AS asset
				ON asset.envelope_id = candidate.e AND asset.recipient_id = candidate.r
				AND asset.sha256 = candidate.h
		`;
		const retirable: boolean[] = scopes.map((): boolean => false);
		for (const row of rows) retirable[Number(row.position) - 1] = row.retirable;
		return retirable;
	}

	async listPendingBefore(
		touchedBefore: string,
		limit: number
	): Promise<readonly SignatureAssetScope[]> {
		const rows = await this.#sql<{ envelopeId: string; recipientId: string; sha256: string }[]>`
			SELECT envelope_id AS "envelopeId", recipient_id AS "recipientId", sha256
			FROM signature_asset
			WHERE state = ${PENDING} AND pending_touched_at <= ${touchedBefore}::timestamptz
			ORDER BY pending_touched_at ASC
			LIMIT ${limit}
		`;
		return rows;
	}

	async retireAbandonedRegistrations(
		scopes: readonly SignatureAssetScope[],
		touchedBefore: string,
		now: string
	): Promise<number> {
		assertSignatureLedgerBatch(scopes);
		if (scopes.length === 0) return 0;
		const { e, r, h } = scopeArrays(scopes);
		const rows = await this.#sql`
			UPDATE signature_asset AS asset
			SET state = ${RETIRED}, retired_at = ${now}::timestamptz, pending_touched_at = NULL
			FROM unnest(${e}::text[], ${r}::text[], ${h}::text[]) AS candidate(e, r, h)
			WHERE asset.envelope_id = candidate.e AND asset.recipient_id = candidate.r
				AND asset.sha256 = candidate.h AND asset.state = ${PENDING}
				AND asset.pending_touched_at <= ${touchedBefore}::timestamptz
			RETURNING asset.envelope_id
		`;
		return rows.length;
	}

	private async readState(scope: SignatureAssetScope): Promise<SignatureAssetState | null> {
		return await readState(this.#sql, scope);
	}
}

async function readState(
	sql: Sql,
	scope: SignatureAssetScope
): Promise<SignatureAssetState | null> {
	const rows = await sql<{ state: SignatureAssetState }[]>`
		SELECT state FROM signature_asset
		WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
			AND sha256 = ${scope.sha256}
	`;
	if (rows.length === 0) return null;
	return rows[0].state;
}

function scopeArrays(scopes: readonly SignatureAssetScope[]): {
	e: string[];
	r: string[];
	h: string[];
} {
	return {
		e: scopes.map((scope: SignatureAssetScope): string => scope.envelopeId),
		r: scopes.map((scope: SignatureAssetScope): string => scope.recipientId),
		h: scopes.map((scope: SignatureAssetScope): string => scope.sha256)
	};
}

function scopeKey(scope: SignatureAssetScope): string {
	return JSON.stringify([scope.envelopeId, scope.recipientId, scope.sha256]);
}

function compareScopes(left: SignatureAssetScope, right: SignatureAssetScope): number {
	const a: string = scopeKey(left);
	const b: string = scopeKey(right);
	return a < b ? -1 : a > b ? 1 : 0;
}
