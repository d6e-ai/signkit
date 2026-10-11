import type {
	RegisterSignatureAssetResult,
	SignatureAssetFreshnessResult,
	SignatureAssetLedger,
	SignatureAssetScope,
	SignatureAssetState
} from './signature-asset-ledger';
import { assertSignatureLedgerBatch } from './signature-asset-ledger';

export const PENDING: SignatureAssetState = `pending`;
export const BOUND: SignatureAssetState = `bound`;
export const RETIRED: SignatureAssetState = `retired`;

interface LedgerRow {
	scope: SignatureAssetScope;
	state: SignatureAssetState;
	pendingTouchedAt: string | null;
}

function scopeKey(scope: SignatureAssetScope): string {
	return `${scope.envelopeId}|${scope.recipientId}|${scope.sha256}`;
}

/**
 * Faithful in-memory `SignatureAssetLedger` double, mirroring the upsert
 * guards the D1/PostgreSQL adapters enforce in the database. `bindForPublish`
 * stands in for the store's atomic publish-time bind. Ownership of live rows
 * is not modeled here; the D1/PostgreSQL integration specs cover it.
 */
export class InMemorySignatureAssetLedger implements SignatureAssetLedger {
	private readonly rows = new Map<string, LedgerRow>();
	/** Test assertion: the `now` of the most recent `retireOrphans` call, if any. */
	lastRetirementAt: string | null = null;

	async registerPending(
		scope: SignatureAssetScope,
		now: string
	): Promise<RegisterSignatureAssetResult> {
		const key: string = scopeKey(scope);
		const existing: LedgerRow | undefined = this.rows.get(key);
		if (existing === undefined) {
			this.rows.set(key, { scope, state: PENDING, pendingTouchedAt: now });
			return `ok`;
		}
		if (existing.state === RETIRED) return `retired`;
		if (existing.state === PENDING) existing.pendingTouchedAt = now;
		return `ok`;
	}

	async checkFresh(
		scope: SignatureAssetScope,
		now: string
	): Promise<SignatureAssetFreshnessResult> {
		const existing: LedgerRow | undefined = this.rows.get(scopeKey(scope));
		if (existing === undefined) return `missing`;
		if (existing.state === PENDING) existing.pendingTouchedAt = now;
		return existing.state;
	}

	async retireOrphans(
		scopes: readonly SignatureAssetScope[],
		now: string,
		touchedBefore: string
	): Promise<readonly SignatureAssetState[]> {
		assertSignatureLedgerBatch(scopes);
		this.lastRetirementAt = now;
		return scopes.map((scope: SignatureAssetScope): SignatureAssetState =>
			this.retireOne(scope, touchedBefore)
		);
	}

	private retireOne(scope: SignatureAssetScope, touchedBefore: string): SignatureAssetState {
		const key: string = scopeKey(scope);
		const existing: LedgerRow | undefined = this.rows.get(key);
		if (existing === undefined) {
			this.rows.set(key, { scope, state: RETIRED, pendingTouchedAt: null });
			return RETIRED;
		}
		if (existing.state === PENDING && (existing.pendingTouchedAt ?? ``) <= touchedBefore) {
			existing.state = RETIRED;
			existing.pendingTouchedAt = null;
		}
		return existing.state;
	}

	async previewRetirements(
		scopes: readonly SignatureAssetScope[],
		touchedBefore: string
	): Promise<readonly boolean[]> {
		assertSignatureLedgerBatch(scopes);
		return scopes.map((scope: SignatureAssetScope): boolean => {
			const existing: LedgerRow | undefined = this.rows.get(scopeKey(scope));
			if (existing === undefined) return true;
			if (existing.state === RETIRED) return true;
			if (existing.state === BOUND) return false;
			return (existing.pendingTouchedAt ?? ``) <= touchedBefore;
		});
	}

	async listPendingBefore(
		touchedBefore: string,
		limit: number
	): Promise<readonly SignatureAssetScope[]> {
		const entries: LedgerRow[] = [...this.rows.values()].filter(
			(row: LedgerRow): boolean =>
				row.state === PENDING && (row.pendingTouchedAt ?? ``) <= touchedBefore
		);
		entries.sort((left: LedgerRow, right: LedgerRow): number =>
			(left.pendingTouchedAt ?? ``) < (right.pendingTouchedAt ?? ``) ? -1 : 1
		);
		return entries.slice(0, limit).map((row: LedgerRow): SignatureAssetScope => row.scope);
	}

	async retireAbandonedRegistrations(
		scopes: readonly SignatureAssetScope[],
		touchedBefore: string
	): Promise<number> {
		assertSignatureLedgerBatch(scopes);
		let retired: number = 0;
		for (const scope of scopes) {
			const existing: LedgerRow | undefined = this.rows.get(scopeKey(scope));
			if (existing === undefined || existing.state !== PENDING) continue;
			if ((existing.pendingTouchedAt ?? ``) > touchedBefore) continue;
			existing.state = RETIRED;
			existing.pendingTouchedAt = null;
			retired += 1;
		}
		return retired;
	}

	/** Test double of the publish-time bind: false (nothing written) when the scope is retired. */
	bindForPublish(scope: SignatureAssetScope): boolean {
		const key: string = scopeKey(scope);
		const existing: LedgerRow | undefined = this.rows.get(key);
		if (existing?.state === RETIRED) return false;
		this.rows.set(key, { scope, state: BOUND, pendingTouchedAt: null });
		return true;
	}

	/** Test setup: seeds a scope directly into a given state, bypassing the guarded transitions above. */
	seed(
		scope: SignatureAssetScope,
		state: SignatureAssetState,
		pendingTouchedAt: string | null = null
	): void {
		this.rows.set(scopeKey(scope), { scope, state, pendingTouchedAt });
	}

	/** Test assertion: the current state of a scope, or undefined when no row exists. */
	stateOf(scope: SignatureAssetScope): SignatureAssetState | undefined {
		return this.rows.get(scopeKey(scope))?.state;
	}
}
