import {
	canonicalizeWorkloadKeyScopesJson,
	isWorkloadKeyScope,
	type WorkloadKeyScope
} from '$lib/security/workload-key';

export const MAX_WORKLOAD_KEY_LIST_LIMIT: number = 100;
export const DEFAULT_WORKLOAD_KEY_LIST_LIMIT: number = 25;
export const WORKLOAD_KEY_IDEMPOTENCY_KEY_MAX_LENGTH: number = 200;
/** Printable ASCII only, mirroring the SQL `NOT GLOB '*[^!-~]*'` bound. */
export const WORKLOAD_KEY_IDEMPOTENCY_KEY_PATTERN: RegExp = /^[!-~]{1,200}$/;
export const WORKLOAD_KEY_ID_PATTERN: RegExp =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Workload keys are always minted by an authenticated cookie user session. */
export type WorkloadKeyActorType = 'user';

export interface WorkloadKeyActor {
	type: WorkloadKeyActorType;
	id: string;
}

/**
 * The only workload key projection any caller may observe. It deliberately
 * omits `token_hash` and `created_by_user_id`: the hash is credential
 * material, and the creating user is audit state rather than list output.
 */
export interface WorkloadKeyMetadata {
	id: string;
	name: string;
	keyPrefix: string;
	scopes: readonly WorkloadKeyScope[];
	createdAt: string;
	expiresAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

/**
 * One create attempt. The organization projection fields let the store upsert
 * a first-seen d6e-auth organization in the same atomic unit as the key, while
 * `tokenHash`/`keyPrefix` are the only credential-derived values persisted: the
 * plaintext `signkit_` secret never reaches this port.
 */
export interface CreateWorkloadKeyCommand {
	organizationId: string;
	organizationName: string;
	actor: WorkloadKeyActor;
	idempotencyKey: string;
	requestFingerprint: string;
	workloadKeyId: string;
	name: string;
	scopes: readonly WorkloadKeyScope[];
	tokenHash: string;
	keyPrefix: string;
	createdAt: string;
	expiresAt: string;
}

/**
 * Provider-independent create outcomes.
 *
 * - `created`: the key, its receipt, and the organization projection landed
 *   atomically.
 * - `already_issued`: an exact replay of the same request under the same
 *   idempotency key. The one-time secret cannot be recovered, so only the
 *   current metadata of the originally issued key is returned.
 * - `idempotency_conflict`: the idempotency key was reused for a different
 *   request, or the durable receipt cannot be proven against the key it
 *   references (a corrupted receipt can never be treated as a safe replay).
 * - `key_id_conflict` / `token_hash_conflict`: the generated UUID or the
 *   credential hash already exists. Both are retryable with fresh material.
 * - `integrity_error`: the organization projection disagrees with its d6e-auth
 *   identifier, or the receipt and key rows cannot be reconciled.
 */
export type CreateWorkloadKeyStoreResult =
	| { outcome: 'created'; key: WorkloadKeyMetadata }
	| { outcome: 'already_issued'; key: WorkloadKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'key_id_conflict' }
	| { outcome: 'token_hash_conflict' }
	| { outcome: 'integrity_error' };

export interface WorkloadKeyListQuery {
	cursor: string | null;
	limit: number;
}

export interface WorkloadKeyListPage {
	items: readonly WorkloadKeyMetadata[];
	nextCursor: string | null;
}

export interface RevokeWorkloadKeyCommand {
	organizationId: string;
	actor: WorkloadKeyActor;
	idempotencyKey: string;
	requestFingerprint: string;
	workloadKeyId: string;
	revokedAt: string;
}

/**
 * Provider-independent revoke outcomes.
 *
 * - `revoked`: this call recorded `revoked_at` plus the single revoke receipt.
 * - `replayed`: an exact replay under the original idempotency key, proven
 *   against the current key row.
 * - `already_revoked`: a fresh idempotency key for a key that is already
 *   revoked. No second receipt is written, so the one-receipt-per-key
 *   invariant holds.
 * - `idempotency_conflict`: the idempotency key was reused for a different key
 *   or a different request fingerprint.
 * - `not_found`: unknown or cross-tenant key id, reported opaquely.
 * - `integrity_error`: the receipt and key rows disagree.
 */
export type RevokeWorkloadKeyStoreResult =
	| { outcome: 'revoked'; key: WorkloadKeyMetadata }
	| { outcome: 'replayed'; key: WorkloadKeyMetadata }
	| { outcome: 'already_revoked'; key: WorkloadKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'integrity_error' };

/**
 * Durable organization-scoped workload key management. Every operation is
 * tenant-scoped by `organizationId`; no implementation may accept a key id
 * without it. Create and revoke are single atomic units that write the state
 * change and its command receipt together, and classify concurrent failures
 * from explicit evidence queries rather than from provider error strings.
 */
export interface WorkloadKeyStore {
	createWorkloadKey(command: CreateWorkloadKeyCommand): Promise<CreateWorkloadKeyStoreResult>;
	listWorkloadKeys(
		organizationId: string,
		query: WorkloadKeyListQuery
	): Promise<WorkloadKeyListPage>;
	revokeWorkloadKey(command: RevokeWorkloadKeyCommand): Promise<RevokeWorkloadKeyStoreResult>;
}

export function boundWorkloadKeyListLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_WORKLOAD_KEY_LIST_LIMIT);
}

export function isWorkloadKeyIdempotencyKey(value: string): boolean {
	return WORKLOAD_KEY_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function isWorkloadKeyId(value: string): boolean {
	return WORKLOAD_KEY_ID_PATTERN.test(value);
}

export function workloadKeyScopesJson(scopes: readonly WorkloadKeyScope[]): string {
	return canonicalizeWorkloadKeyScopesJson(scopes);
}

/**
 * Read stored scopes back without trusting them. Anything that is not the
 * canonical nonempty unique subset serialization returns null so callers fail
 * closed instead of surfacing drifted authority.
 */
export function parseWorkloadKeyScopesJson(scopesJson: string): readonly WorkloadKeyScope[] | null {
	let value: unknown;
	try {
		value = JSON.parse(scopesJson);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length === 0) return null;
	const scopes: WorkloadKeyScope[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string' || !isWorkloadKeyScope(entry) || scopes.includes(entry)) {
			return null;
		}
		scopes.push(entry);
	}
	// Byte-exact canonical form only: reordered or re-spaced JSON is drift.
	return canonicalizeWorkloadKeyScopesJson(scopes) === scopesJson ? scopes : null;
}
