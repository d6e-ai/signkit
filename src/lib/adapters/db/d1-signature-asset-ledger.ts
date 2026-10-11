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

/** Exact scoped `field_value` reference to `?1`/`?2`/`?6`, shared by retirement and its preview. */
const D1_SCOPED_REFERENCE: string = `SELECT 1 FROM field_value
	 WHERE envelope_id = ?1 AND recipient_id = ?2
	   AND field_type IN ('signature', 'initials') AND value_json = ?6`;

const D1_SCOPED_OWNER: string = `SELECT 1 FROM recipient WHERE id = ?2 AND envelope_id = ?1`;

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

	async retireOrphan(
		scope: SignatureAssetScope,
		now: string,
		touchedBefore: string
	): Promise<RetireSignatureAssetResult> {
		// One atomic statement: a missing row is inserted as bound when an exact
		// scoped field value already names it (legacy backfill) and retired
		// otherwise; an existing row retires only while still pending, untouched
		// since touchedBefore, and unreferenced. `WHERE true` disambiguates the
		// upsert from a join, as SQLite requires for INSERT ... SELECT.
		await this.database
			.prepare(
				`INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, bound_at, retired_at)
				 SELECT ?1, ?2, ?3,
				   CASE WHEN EXISTS (${D1_SCOPED_REFERENCE}) THEN '${BOUND}' ELSE '${RETIRED}' END,
				   ?4,
				   CASE WHEN EXISTS (${D1_SCOPED_REFERENCE}) THEN ?4 ELSE NULL END,
				   CASE WHEN EXISTS (${D1_SCOPED_REFERENCE}) THEN NULL ELSE ?4 END
				 WHERE EXISTS (${D1_SCOPED_OWNER})
				 ON CONFLICT (envelope_id, recipient_id, sha256) DO UPDATE SET
				   state = '${RETIRED}', retired_at = ?4, pending_touched_at = NULL
				 WHERE signature_asset.state = '${PENDING}'
				   AND signature_asset.pending_touched_at <= ?5
				   AND NOT EXISTS (${D1_SCOPED_REFERENCE})`
			)
			.bind(
				scope.envelopeId,
				scope.recipientId,
				scope.sha256,
				now,
				touchedBefore,
				signatureAssetRefValueJson(scope.sha256)
			)
			.run();
		const state: SignatureAssetState | null = await this.readState(scope);
		return state ?? `unowned`;
	}

	async previewRetirement(scope: SignatureAssetScope, touchedBefore: string): Promise<boolean> {
		const row: PreviewRow | null = await this.database
			.prepare(
				`SELECT
				   (SELECT state FROM signature_asset
				    WHERE envelope_id = ?1 AND recipient_id = ?2 AND sha256 = ?3) AS state,
				   (SELECT pending_touched_at FROM signature_asset
				    WHERE envelope_id = ?1 AND recipient_id = ?2 AND sha256 = ?3) AS pending_touched_at,
				   EXISTS (${D1_SCOPED_REFERENCE}) AS referenced`
			)
			.bind(
				scope.envelopeId,
				scope.recipientId,
				scope.sha256,
				null,
				null,
				signatureAssetRefValueJson(scope.sha256)
			)
			.first<PreviewRow>();
		if (row === null) return false;
		return previewFromRow(row, touchedBefore);
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

	async retireAbandonedPending(
		scope: SignatureAssetScope,
		touchedBefore: string,
		now: string
	): Promise<boolean> {
		const result = await this.database
			.prepare(
				`UPDATE signature_asset SET state = ?, retired_at = ?, pending_touched_at = NULL
				 WHERE envelope_id = ? AND recipient_id = ? AND sha256 = ?
				   AND state = ? AND pending_touched_at <= ?`
			)
			.bind(RETIRED, now, scope.envelopeId, scope.recipientId, scope.sha256, PENDING, touchedBefore)
			.run();
		return (result.meta.changes ?? 0) === 1;
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

/** Mirrors the guarded retirement statement without writing. A missing, unreferenced row is retirable (or unowned). */
function previewFromRow(row: PreviewRow, touchedBefore: string): boolean {
	if (row.state === RETIRED) return true;
	if (row.state === BOUND) return false;
	if (row.referenced === 1) return false;
	if (row.state === null) return true;
	return row.pending_touched_at !== null && row.pending_touched_at <= touchedBefore;
}
