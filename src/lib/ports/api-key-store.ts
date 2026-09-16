import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import {
	canonicalizeApiKeyScopesJson,
	isApiKeyScope,
	type ApiKeyScope
} from '$lib/security/api-key';

export const MAX_API_KEY_LIST_LIMIT: number = 100;
export const DEFAULT_API_KEY_LIST_LIMIT: number = 25;
export const API_KEY_IDEMPOTENCY_KEY_MAX_LENGTH: number = 200;
/** Printable ASCII only, mirroring the SQL `NOT GLOB '*[^!-~]*'` bound. */
export const API_KEY_IDEMPOTENCY_KEY_PATTERN: RegExp = /^[!-~]{1,200}$/;
/** API key records are SignKit-owned, so their IDs are UUIDv7. */
export const API_KEY_ID_PATTERN: RegExp = UUID_V7_PATTERN;

/** API keys are always minted by an authenticated cookie user session. */
export type ApiKeyActorType = 'user';

export interface ApiKeyActor {
	type: ApiKeyActorType;
	id: string;
}

/**
 * The only API key projection any caller may observe. It deliberately omits
 * `token_hash` and `owner_user_id`: the hash is credential material, and the
 * owning member is implied by the owner-scoped query rather than list output.
 */
export interface ApiKeyMetadata {
	id: string;
	name: string;
	keyPrefix: string;
	scopes: readonly ApiKeyScope[];
	createdAt: string;
	expiresAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

/**
 * One create attempt. `tokenHash`/`keyPrefix` are the only credential-derived
 * values persisted: the plaintext `signkit_` secret never reaches this port.
 * The actor is the owner. The store requires that actor to be a currently
 * active `instance_member` in the same atomic unit as the key insert.
 */
export interface CreateApiKeyCommand {
	actor: ApiKeyActor;
	idempotencyKey: string;
	requestFingerprint: string;
	apiKeyId: string;
	name: string;
	scopes: readonly ApiKeyScope[];
	tokenHash: string;
	keyPrefix: string;
	createdAt: string;
	expiresAt: string;
}

/**
 * Provider-independent create outcomes.
 *
 * - `created`: the key and its receipt landed atomically for an active owner.
 * - `already_issued`: an exact replay of the same request under the same
 *   idempotency key. The one-time secret cannot be recovered, so only the
 *   current metadata of the originally issued key is returned.
 * - `idempotency_conflict`: the idempotency key was reused for a different
 *   request, or the durable receipt cannot be proven against the key it
 *   references (a corrupted receipt can never be treated as a safe replay).
 * - `key_id_conflict` / `token_hash_conflict`: the generated UUID or the
 *   credential hash already exists. Both are retryable with fresh material.
 * - `owner_not_active`: the actor is missing or suspended. Fail closed; no
 *   key or receipt is written.
 * - `integrity_error`: the receipt and key rows cannot be reconciled.
 */
export type CreateApiKeyStoreResult =
	| { outcome: 'created'; key: ApiKeyMetadata }
	| { outcome: 'already_issued'; key: ApiKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'key_id_conflict' }
	| { outcome: 'token_hash_conflict' }
	| { outcome: 'owner_not_active' }
	| { outcome: 'integrity_error' };

export interface ApiKeyListQuery {
	cursor: string | null;
	limit: number;
}

export interface ApiKeyListPage {
	items: readonly ApiKeyMetadata[];
	nextCursor: string | null;
}

export type ListApiKeyStoreResult =
	{ outcome: 'listed'; page: ApiKeyListPage } | { outcome: 'owner_not_active' };

export interface RevokeApiKeyCommand {
	actor: ApiKeyActor;
	idempotencyKey: string;
	requestFingerprint: string;
	apiKeyId: string;
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
 * - `not_found`: unknown or cross-owner key id, reported opaquely.
 * - `owner_not_active`: the actor is missing or suspended.
 * - `integrity_error`: the receipt and key rows disagree.
 */
export type RevokeApiKeyStoreResult =
	| { outcome: 'revoked'; key: ApiKeyMetadata }
	| { outcome: 'replayed'; key: ApiKeyMetadata }
	| { outcome: 'already_revoked'; key: ApiKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'owner_not_active' }
	| { outcome: 'integrity_error' };

/**
 * Durable owner-scoped API key management. Every operation is scoped to the
 * calling instance member; no implementation may accept a key id without the
 * actor. Create, list, and revoke require that actor to be currently `active`
 * at the durable query/write boundary. Create and revoke are single atomic
 * units that write the state change and its command receipt together, and
 * classify concurrent failures from explicit evidence queries rather than from
 * provider error strings. Idempotency is primary-keyed by actor user plus
 * Idempotency-Key.
 */
export interface ApiKeyStore {
	createApiKey(command: CreateApiKeyCommand): Promise<CreateApiKeyStoreResult>;
	listApiKeys(actor: ApiKeyActor, query: ApiKeyListQuery): Promise<ListApiKeyStoreResult>;
	revokeApiKey(command: RevokeApiKeyCommand): Promise<RevokeApiKeyStoreResult>;
}

export function boundApiKeyListLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_API_KEY_LIST_LIMIT);
}

export function isApiKeyIdempotencyKey(value: string): boolean {
	return API_KEY_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function isApiKeyId(value: string): boolean {
	return API_KEY_ID_PATTERN.test(value);
}

export function apiKeyScopesJson(scopes: readonly ApiKeyScope[]): string {
	return canonicalizeApiKeyScopesJson(scopes);
}

/**
 * Read stored scopes back without trusting them. Anything that is not the
 * canonical nonempty unique subset serialization returns null so callers fail
 * closed instead of surfacing drifted authority.
 */
export function parseApiKeyScopesJson(scopesJson: string): readonly ApiKeyScope[] | null {
	let value: unknown;
	try {
		value = JSON.parse(scopesJson);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length === 0) return null;
	const scopes: ApiKeyScope[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string' || !isApiKeyScope(entry) || scopes.includes(entry)) {
			return null;
		}
		scopes.push(entry);
	}
	// Byte-exact canonical form only: reordered or re-spaced JSON is drift.
	return canonicalizeApiKeyScopesJson(scopes) === scopesJson ? scopes : null;
}
