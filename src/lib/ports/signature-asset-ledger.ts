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
 * Outcome of an orphan retirement attempt. `retired` is the only state whose
 * object may be deleted; `unowned` means no recipient of that envelope exists
 * any longer, so no signing command can ever bind the key and no tombstone is
 * needed (or insertable under the scoped-owner guard).
 */
export type RetireSignatureAssetResult = SignatureAssetState | 'unowned';

/** Scoped by (envelope, recipient, sha256). pending exists from upload until a signed field value binds it (bound, permanent) or the orphan sweep retires it (retired, permanent). */
export interface SignatureAssetLedger {
	/** Registers or refreshes a pending row before the object store put. A retired scope rejects the upload instead of resurrecting it. */
	registerPending(scope: SignatureAssetScope, now: string): Promise<RegisterSignatureAssetResult>;
	/** Touches pending retention for a fresh sign submission; never resurrects retired. missing covers a forged ref or a pre-ledger legacy asset. */
	checkFresh(scope: SignatureAssetScope, now: string): Promise<SignatureAssetFreshnessResult>;
	/**
	 * Orphan sweep's sole retirement entry point for a scoped key already
	 * proven unreferenced. The database re-checks the exact scoped field_value
	 * reference in the same statement/transaction. Pending touched after
	 * touchedBefore stays pending (pending touch wins); bound never retires; a
	 * missing row (legacy, pre-ledger) is inserted atomically as bound when a
	 * field value names it, otherwise as retired; already-retired is idempotent
	 * for retry after a crash or delete ambiguity.
	 */
	retireOrphan(
		scope: SignatureAssetScope,
		now: string,
		touchedBefore: string
	): Promise<RetireSignatureAssetResult>;
	/** Read-only dry-run counterpart of {@link retireOrphan}: true when a real sweep would retire (or already retired) this scope. */
	previewRetirement(scope: SignatureAssetScope, touchedBefore: string): Promise<boolean>;
	/** Bounded, oldest-first page of pending scopes last touched before touchedBefore. */
	listPendingBefore(touchedBefore: string, limit: number): Promise<readonly SignatureAssetScope[]>;
	/** Retires exactly this scope only while still pending and not touched at or after touchedBefore. */
	retireAbandonedPending(
		scope: SignatureAssetScope,
		touchedBefore: string,
		now: string
	): Promise<boolean>;
}
