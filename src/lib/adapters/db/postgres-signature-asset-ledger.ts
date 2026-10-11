import postgres from 'postgres';
import type {
	RegisterSignatureAssetResult,
	RetireSignatureAssetResult,
	SignatureAssetFreshnessResult,
	SignatureAssetLedger,
	SignatureAssetScope,
	SignatureAssetState
} from '$lib/ports/signature-asset-ledger';
import { signatureAssetRefValueJson } from '$lib/ports/signature-asset-ledger';

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

	async retireOrphan(
		scope: SignatureAssetScope,
		now: string,
		touchedBefore: string
	): Promise<RetireSignatureAssetResult> {
		const valueJson: string = signatureAssetRefValueJson(scope.sha256);
		return await this.#sql.begin(
			async (transaction: postgres.TransactionSql): Promise<RetireSignatureAssetResult> => {
				// Lock the scoped row first so a concurrent recipient-signed
				// transaction's bind either already committed (seen as bound
				// below) or waits until this retirement commits (then fails closed).
				const locked = await transaction<{ state: SignatureAssetState }[]>`
					SELECT state FROM signature_asset
					WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
						AND sha256 = ${scope.sha256}
					FOR UPDATE
				`;
				if (locked.length === 0) {
					// Legacy, pre-ledger object (its recipient may no longer exist:
					// a tombstone needs no live owner, a bound row does). A
					// concurrent insert of the same scope makes this DO NOTHING;
					// the re-read then reports it.
					await transaction`
						INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, bound_at, retired_at)
						SELECT ${scope.envelopeId}, ${scope.recipientId}, ${scope.sha256},
							CASE WHEN reference.live THEN ${BOUND} ELSE ${RETIRED} END,
							${now}::timestamptz,
							CASE WHEN reference.live THEN ${now}::timestamptz END,
							CASE WHEN reference.live THEN NULL ELSE ${now}::timestamptz END
						FROM (
							SELECT EXISTS (
								SELECT 1 FROM field_value
								WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
									AND field_type IN ('signature', 'initials') AND value_json = ${valueJson}
							) AS live
						) reference
						ON CONFLICT (envelope_id, recipient_id, sha256) DO NOTHING
					`;
				} else if (locked[0].state === PENDING) {
					await transaction`
						UPDATE signature_asset
						SET state = ${RETIRED}, retired_at = ${now}::timestamptz, pending_touched_at = NULL
						WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
							AND sha256 = ${scope.sha256} AND state = ${PENDING}
							AND pending_touched_at <= ${touchedBefore}::timestamptz
							AND NOT EXISTS (
								SELECT 1 FROM field_value
								WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
									AND field_type IN ('signature', 'initials') AND value_json = ${valueJson}
							)
					`;
				}
				const state: SignatureAssetState | null = await readState(transaction, scope);
				if (state === null) throw new Error('signature asset retirement left no ledger row');
				return state;
			}
		);
	}

	async previewRetirement(scope: SignatureAssetScope, touchedBefore: string): Promise<boolean> {
		const valueJson: string = signatureAssetRefValueJson(scope.sha256);
		const rows = await this.#sql<{ retirable: boolean }[]>`
			SELECT CASE
				WHEN asset.state = ${RETIRED} THEN true
				WHEN asset.state = ${BOUND} THEN false
				WHEN EXISTS (
					SELECT 1 FROM field_value
					WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
						AND field_type IN ('signature', 'initials') AND value_json = ${valueJson}
				) THEN false
				WHEN asset.state IS NULL THEN true
				ELSE asset.pending_touched_at <= ${touchedBefore}::timestamptz
			END AS retirable
			FROM (SELECT 1) AS anchor
			LEFT JOIN signature_asset asset
				ON asset.envelope_id = ${scope.envelopeId} AND asset.recipient_id = ${scope.recipientId}
					AND asset.sha256 = ${scope.sha256}
		`;
		return rows[0]?.retirable === true;
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

	async retireAbandonedPending(
		scope: SignatureAssetScope,
		touchedBefore: string,
		now: string
	): Promise<boolean> {
		const rows = await this.#sql`
			UPDATE signature_asset SET state = ${RETIRED}, retired_at = ${now}::timestamptz, pending_touched_at = NULL
			WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
				AND sha256 = ${scope.sha256} AND state = ${PENDING}
				AND pending_touched_at <= ${touchedBefore}::timestamptz
			RETURNING envelope_id
		`;
		return rows.length === 1;
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
