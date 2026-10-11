export type SignatureAssetState = 'pending' | 'bound' | 'retired';

export interface SignatureAssetScope {
	envelopeId: string;
	recipientId: string;
	sha256: string;
}

/** The exact `field_value.value_json` a signature/initials field stores for this scope's asset. */
export function signatureAssetRefValueJson(sha256: string): string {
	return JSON.stringify(`sig:sha256:${sha256}`);
}

export type RegisterSignatureAssetResult = 'ok' | 'retired';

export type SignatureAssetFreshnessResult = SignatureAssetState | 'missing';

/**
 * Most scopes one bulk sweep call ({@link SignatureAssetLedger.retireOrphans},
 * `previewRetirements`, `retireAbandonedRegistrations`) accepts. Each such
 * call is a constant number of database statements regardless of its size up
 * to this cap, so a caller with a per-invocation statement quota can budget it.
 */
export const SIGNATURE_LEDGER_BATCH_SIZE: number = 100;

/** Scoped by (envelope, recipient, sha256). pending exists from upload until a signed field value binds it (bound, permanent) or the orphan sweep retires it (retired, permanent). */
export interface SignatureAssetLedger {
	/** Registers or refreshes a pending row before the object store put. A retired scope rejects the upload instead of resurrecting it. */
	registerPending(scope: SignatureAssetScope, now: string): Promise<RegisterSignatureAssetResult>;
	/** Touches pending retention for a fresh sign submission; never resurrects retired. missing covers a forged ref or a pre-ledger legacy asset. */
	checkFresh(scope: SignatureAssetScope, now: string): Promise<SignatureAssetFreshnessResult>;
	/**
	 * Orphan sweep's sole retirement entry point for distinct scoped keys
	 * already proven unreferenced (at most {@link SIGNATURE_LEDGER_BATCH_SIZE}).
	 * Returns each scope's durable state after the attempt, in input order;
	 * `retired` is the only state whose object may be deleted, and it is always
	 * backed by a committed one-way tombstone.
	 *
	 * Per scope, the database re-checks the exact scoped field_value reference
	 * in the same statement/transaction. Pending touched after touchedBefore
	 * stays pending (pending touch wins); bound never retires; a missing row
	 * (legacy, pre-ledger, even with no live owner) is inserted atomically as
	 * bound when a field value names it, otherwise as a retired tombstone;
	 * already-retired is idempotent for retry after a crash or delete
	 * ambiguity. Live (pending/bound) rows always require the exact scoped
	 * owner; tombstones do not, so an owner created or restored later can never
	 * re-register, reuse, or bind a retired key.
	 */
	retireOrphans(
		scopes: readonly SignatureAssetScope[],
		now: string,
		touchedBefore: string
	): Promise<readonly SignatureAssetState[]>;
	/** Read-only dry-run counterpart of {@link retireOrphans}: per scope, in input order, true when a real sweep would retire (or already retired) it. */
	previewRetirements(
		scopes: readonly SignatureAssetScope[],
		touchedBefore: string
	): Promise<readonly boolean[]>;
	/** Bounded, oldest-first page of pending scopes last touched before touchedBefore. */
	listPendingBefore(touchedBefore: string, limit: number): Promise<readonly SignatureAssetScope[]>;
	/** Retires exactly these scopes, each only while still pending and not touched after touchedBefore. Returns how many it retired. */
	retireAbandonedRegistrations(
		scopes: readonly SignatureAssetScope[],
		touchedBefore: string,
		now: string
	): Promise<number>;
}

/** Throws when a bulk call exceeds {@link SIGNATURE_LEDGER_BATCH_SIZE}, keeping its statement cost bounded. */
export function assertSignatureLedgerBatch(scopes: readonly SignatureAssetScope[]): void {
	if (scopes.length > SIGNATURE_LEDGER_BATCH_SIZE) {
		throw new RangeError(`at most ${SIGNATURE_LEDGER_BATCH_SIZE} scopes per ledger call`);
	}
}
