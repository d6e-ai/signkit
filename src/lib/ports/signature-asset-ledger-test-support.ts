import type {
	RegisterSignatureAssetResult,
	RetireSignatureAssetResult,
	SignatureAssetFreshnessResult,
	SignatureAssetLedger,
	SignatureAssetScope,
	SignatureAssetState
} from './signature-asset-ledger';

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
 * stands in for the store's atomic publish-time bind, and `markUnowned`
 * simulates a scope whose recipient no longer exists.
 */
export class InMemorySignatureAssetLedger implements SignatureAssetLedger {
	private readonly rows = new Map<string, LedgerRow>();
	private readonly unowned = new Set<string>();

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

	async retireOrphan(
		scope: SignatureAssetScope,
		now: string,
		touchedBefore: string
	): Promise<RetireSignatureAssetResult> {
		const key: string = scopeKey(scope);
		const existing: LedgerRow | undefined = this.rows.get(key);
		if (existing === undefined) {
			if (this.unowned.has(key)) return `unowned`;
			this.rows.set(key, { scope, state: RETIRED, pendingTouchedAt: null });
			return RETIRED;
		}
		if (existing.state === PENDING && (existing.pendingTouchedAt ?? ``) <= touchedBefore) {
			existing.state = RETIRED;
			existing.pendingTouchedAt = null;
		}
		return existing.state;
	}

	async previewRetirement(scope: SignatureAssetScope, touchedBefore: string): Promise<boolean> {
		const existing: LedgerRow | undefined = this.rows.get(scopeKey(scope));
		if (existing === undefined) return true;
		if (existing.state === RETIRED) return true;
		if (existing.state === BOUND) return false;
		return (existing.pendingTouchedAt ?? ``) <= touchedBefore;
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

	async retireAbandonedPending(
		scope: SignatureAssetScope,
		touchedBefore: string
	): Promise<boolean> {
		const existing: LedgerRow | undefined = this.rows.get(scopeKey(scope));
		if (existing === undefined) return false;
		if (existing.state !== PENDING) return false;
		if ((existing.pendingTouchedAt ?? ``) > touchedBefore) return false;
		existing.state = RETIRED;
		existing.pendingTouchedAt = null;
		return true;
	}

	/** Test double of the publish-time bind: false (nothing written) when the scope is retired. */
	bindForPublish(scope: SignatureAssetScope): boolean {
		const key: string = scopeKey(scope);
		const existing: LedgerRow | undefined = this.rows.get(key);
		if (existing?.state === RETIRED) return false;
		this.rows.set(key, { scope, state: BOUND, pendingTouchedAt: null });
		return true;
	}

	/** Test setup: the scope's recipient no longer exists, so no tombstone can be inserted. */
	markUnowned(scope: SignatureAssetScope): void {
		this.unowned.add(scopeKey(scope));
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
