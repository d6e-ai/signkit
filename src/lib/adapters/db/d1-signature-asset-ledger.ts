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

/**
 * D1 statements each bulk sweep call executes (every statement counts toward
 * D1's per-invocation query limit, batched or not), for any batch of up to
 * `SIGNATURE_LEDGER_BATCH_SIZE` scopes. An empty batch executes none.
 */
export const D1_SIGNATURE_LEDGER_STATEMENTS = {
	retireOrphans: 2,
	previewRetirements: 1,
	listPendingBefore: 1,
	retireAbandonedRegistrations: 1
} as const;

/** The scope batch bound as `?1` (a JSON array of `[envelopeId, recipientId, sha256]`), as columns e/r/h/position. */
const SCOPES_FROM_JSON: string = `SELECT json_extract(value, '$[0]') AS e, json_extract(value, '$[1]') AS r,
	json_extract(value, '$[2]') AS h, key AS position FROM json_each(?1)`;

/** Exact scoped `sig:sha256:` field_value reference for the given column expressions. */
function scopedReference(envelope: string, recipient: string, sha256: string): string {
	return `SELECT 1 FROM field_value AS reference
		WHERE reference.envelope_id = ${envelope} AND reference.recipient_id = ${recipient}
		  AND reference.field_type IN ('signature', 'initials')
		  AND reference.value_json = '"sig:sha256:' || ${sha256} || '"'`;
}

interface StateRow {
	state: SignatureAssetState;
}

interface PreviewRow {
	state: SignatureAssetState | null;
	pending_touched_at: string | null;
	referenced: number;
}

interface ScopeRow {
	envelope_id: string;
	recipient_id: string;
	sha256: string;
}

export class D1SignatureAssetLedger implements SignatureAssetLedger {
	constructor(private readonly database: D1Database) {}

	async registerPending(
		scope: SignatureAssetScope,
		now: string
	): Promise<RegisterSignatureAssetResult> {
		await this.database
			.prepare(
				`INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, pending_touched_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (envelope_id, recipient_id, sha256) DO UPDATE SET pending_touched_at = ?
				 WHERE signature_asset.state = ?`
			)
			.bind(scope.envelopeId, scope.recipientId, scope.sha256, PENDING, now, now, now, PENDING)
			.run();
		const state: SignatureAssetState | null = await this.readState(scope);
		if (state === RETIRED) return 'retired';
		return `ok`;
	}

	async checkFresh(
		scope: SignatureAssetScope,
		now: string
	): Promise<SignatureAssetFreshnessResult> {
		await this.database
			.prepare(
				`UPDATE signature_asset SET pending_touched_at = ?
				 WHERE envelope_id = ? AND recipient_id = ? AND sha256 = ? AND state = ?`
			)
			.bind(now, scope.envelopeId, scope.recipientId, scope.sha256, PENDING)
			.run();
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
		const serialized: string = serializeScopes(scopes);
		// One atomic statement for the whole batch: a missing row is inserted as
		// bound when an exact scoped field value already names it (legacy
		// backfill) and retired otherwise -- including when its recipient no
		// longer exists, since a tombstone needs no live owner; an existing row
		// retires only while still pending, untouched since touchedBefore, and
		// unreferenced. `WHERE true` disambiguates the upsert from a join, as
		// SQLite requires for INSERT ... SELECT.
		await this.database
			.prepare(
				`INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, bound_at, retired_at)
				 SELECT e, r, h,
				   CASE WHEN live THEN '${BOUND}' ELSE '${RETIRED}' END,
				   ?2,
				   CASE WHEN live THEN ?2 ELSE NULL END,
				   CASE WHEN live THEN NULL ELSE ?2 END
				 FROM (
				   SELECT e, r, h, EXISTS (${scopedReference('e', 'r', 'h')}) AS live
				   FROM (${SCOPES_FROM_JSON}) AS candidate
				 ) AS classified
				 WHERE true
				 ON CONFLICT (envelope_id, recipient_id, sha256) DO UPDATE SET
				   state = '${RETIRED}', retired_at = ?2, pending_touched_at = NULL
				 WHERE signature_asset.state = '${PENDING}'
				   AND signature_asset.pending_touched_at <= ?3
				   AND NOT EXISTS (${scopedReference(
							'signature_asset.envelope_id',
							'signature_asset.recipient_id',
							'signature_asset.sha256'
						)})`
			)
			.bind(serialized, now, touchedBefore)
			.run();
		const rows = await this.database
			.prepare(
				`SELECT asset.envelope_id, asset.recipient_id, asset.sha256, asset.state
				 FROM (${SCOPES_FROM_JSON}) AS candidate
				 INNER JOIN signature_asset AS asset
				   ON asset.envelope_id = candidate.e AND asset.recipient_id = candidate.r
				   AND asset.sha256 = candidate.h`
			)
			.bind(serialized)
			.all<ScopeRow & StateRow>();
		const states: Map<string, SignatureAssetState> = new Map(
			(rows.results ?? []).map((row): [string, SignatureAssetState] => [
				scopeKey({
					envelopeId: row.envelope_id,
					recipientId: row.recipient_id,
					sha256: row.sha256
				}),
				row.state
			])
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
		const rows = await this.database
			.prepare(
				`SELECT candidate.position AS position, asset.state AS state,
				   asset.pending_touched_at AS pending_touched_at,
				   EXISTS (${scopedReference('candidate.e', 'candidate.r', 'candidate.h')}) AS referenced
				 FROM (${SCOPES_FROM_JSON}) AS candidate
				 LEFT JOIN signature_asset AS asset
				   ON asset.envelope_id = candidate.e AND asset.recipient_id = candidate.r
				   AND asset.sha256 = candidate.h`
			)
			.bind(serializeScopes(scopes))
			.all<PreviewRow & { position: number }>();
		const retirable: boolean[] = scopes.map((): boolean => false);
		for (const row of rows.results ?? []) {
			retirable[Number(row.position)] = previewFromRow(row, touchedBefore);
		}
		return retirable;
	}

	async listPendingBefore(
		touchedBefore: string,
		limit: number
	): Promise<readonly SignatureAssetScope[]> {
		const rows = await this.database
			.prepare(
				`SELECT envelope_id, recipient_id, sha256 FROM signature_asset
				 WHERE state = ? AND pending_touched_at <= ?
				 ORDER BY pending_touched_at ASC
				 LIMIT ?`
			)
			.bind(PENDING, touchedBefore, limit)
			.all<ScopeRow>();
		return (rows.results ?? []).map((row: ScopeRow): SignatureAssetScope => ({
			envelopeId: row.envelope_id,
			recipientId: row.recipient_id,
			sha256: row.sha256
		}));
	}

	async retireAbandonedRegistrations(
		scopes: readonly SignatureAssetScope[],
		touchedBefore: string,
		now: string
	): Promise<number> {
		assertSignatureLedgerBatch(scopes);
		if (scopes.length === 0) return 0;
		const result = await this.database
			.prepare(
				`UPDATE signature_asset SET state = '${RETIRED}', retired_at = ?2, pending_touched_at = NULL
				 WHERE state = '${PENDING}' AND pending_touched_at <= ?3
				   AND EXISTS (
				     SELECT 1 FROM (${SCOPES_FROM_JSON}) AS candidate
				     WHERE candidate.e = signature_asset.envelope_id
				       AND candidate.r = signature_asset.recipient_id
				       AND candidate.h = signature_asset.sha256
				   )`
			)
			.bind(serializeScopes(scopes), now, touchedBefore)
			.run();
		return result.meta.changes ?? 0;
	}

	private async readState(scope: SignatureAssetScope): Promise<SignatureAssetState | null> {
		const row: StateRow | null = await this.database
			.prepare(
				`SELECT state FROM signature_asset WHERE envelope_id = ? AND recipient_id = ? AND sha256 = ?`
			)
			.bind(scope.envelopeId, scope.recipientId, scope.sha256)
			.first<StateRow>();
		if (row === null) return null;
		return row.state;
	}
}

function serializeScopes(scopes: readonly SignatureAssetScope[]): string {
	return JSON.stringify(
		scopes.map((scope: SignatureAssetScope): readonly [string, string, string] => [
			scope.envelopeId,
			scope.recipientId,
			scope.sha256
		])
	);
}

function scopeKey(scope: SignatureAssetScope): string {
	return JSON.stringify([scope.envelopeId, scope.recipientId, scope.sha256]);
}

/** Mirrors the guarded retirement statement without writing. A missing, unreferenced row is retirable. */
function previewFromRow(row: PreviewRow, touchedBefore: string): boolean {
	if (row.state === RETIRED) return true;
	if (row.state === BOUND) return false;
	if (row.referenced === 1) return false;
	if (row.state === null) return true;
	return row.pending_touched_at !== null && row.pending_touched_at <= touchedBefore;
}
