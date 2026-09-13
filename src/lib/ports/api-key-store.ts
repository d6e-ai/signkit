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
 * Idempotency-Key. Key ownership never implies organization authorization.
 */
export interface ApiKeyStore {
	createApiKey(command: CreateApiKeyCommand): Promise<CreateApiKeyStoreResult>;
	listApiKeys(actor: ApiKeyActor, query: ApiKeyListQuery): Promise<ListApiKeyStoreResult>;
	revokeApiKey(command: RevokeApiKeyCommand): Promise<RevokeApiKeyStoreResult>;
	grantApiKeyOrganization(
		command: GrantApiKeyOrganizationCommand
	): Promise<GrantApiKeyOrganizationStoreResult>;
	listApiKeyOrganizationGrants(
		query: ApiKeyOrganizationGrantListQuery
	): Promise<ListApiKeyOrganizationGrantsStoreResult>;
	revokeApiKeyOrganizationGrant(
		command: RevokeApiKeyOrganizationGrantCommand
	): Promise<RevokeApiKeyOrganizationGrantStoreResult>;
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

export const MAX_API_KEY_GRANT_LIST_LIMIT: number = 100;
export const DEFAULT_API_KEY_GRANT_LIST_LIMIT: number = 25;
/** Grant records are SignKit-owned, so their IDs are UUIDv7. */
export const API_KEY_GRANT_ID_PATTERN: RegExp = UUID_V7_PATTERN;

/** The d6e organization role that authorized a grant. `member` never suffices. */
export type ApiKeyGrantingOrganizationRole = 'owner' | 'admin';

/** Which de-escalation path retired a grant. */
export type ApiKeyOrganizationGrantRevokeAuthority = 'key_owner' | 'organization_admin';

/**
 * The only grant projection any caller may observe.
 *
 * It carries identifiers, the asserted grantor organization role, timestamps,
 * and the revoking actor -- and deliberately nothing else. There is no token, no
 * token hash, no key prefix, no email, no display name, and no organization
 * name: a grant is an authority record, and its observable form must not become
 * a directory of who or what it touches.
 */
export interface ApiKeyOrganizationGrantMetadata {
	id: string;
	apiKeyId: string;
	organizationId: string;
	grantedByUserId: string;
	grantedOrganizationRole: ApiKeyGrantingOrganizationRole;
	grantedAt: string;
	revokedAt: string | null;
	revokedByUserId: string | null;
	revokedByAuthority: ApiKeyOrganizationGrantRevokeAuthority | null;
}

/**
 * One grant attempt.
 *
 * `actor` is both the granting identity and the required key owner: this slice
 * never lets an instance administrator grant on someone else's key, so the
 * actor, the key's owner, and the caller are the same subject. `organizationId`
 * and `organizationName` come from the caller's own verified d6e-auth
 * membership, never from a request body, and `grantingOrganizationRole` is the
 * role that membership actually carried, recorded as durable evidence.
 *
 * The store must, in one atomic unit: require the actor to be a currently
 * active `instance_member`; require the key to exist, be owned by that actor,
 * be unrevoked, and be unexpired at `grantedAt`; project the organization row;
 * insert the grant; and insert the receipt.
 */
export interface GrantApiKeyOrganizationCommand {
	actor: ApiKeyActor;
	idempotencyKey: string;
	requestFingerprint: string;
	grantId: string;
	apiKeyId: string;
	organizationId: string;
	organizationName: string;
	grantingOrganizationRole: ApiKeyGrantingOrganizationRole;
	grantedAt: string;
}

/**
 * Provider-independent grant outcomes.
 *
 * - `granted`: the grant and its receipt landed atomically.
 * - `replayed`: an exact replay under the original idempotency key, proven
 *   against the grant row the receipt references.
 * - `already_granted`: a fresh idempotency key naming an organization this key is
 *   already live for. The existing grant is returned and no second receipt is
 *   written, so the one-receipt-per-grant invariant holds. Kept distinct from
 *   `replayed` so the HTTP layer can report an idempotent replay honestly
 *   instead of labelling an unrelated request as one.
 * - `idempotency_conflict`: the key was reused for a different request, or the
 *   durable receipt cannot be proven against the grant it references.
 * - `grant_id_conflict`: the generated UUID already exists. Retryable with
 *   fresh material.
 * - `not_found`: unknown or cross-owner key id, reported opaquely.
 * - `key_not_active`: the key exists and is owned by the caller but is revoked
 *   or already expired. Distinguishable because it describes a credential the
 *   caller owns and can already see in their own key list.
 * - `owner_not_active`: the actor is missing or suspended. Fail closed.
 * - `integrity_error`: the receipt and grant rows cannot be reconciled.
 */
export type GrantApiKeyOrganizationStoreResult =
	| { outcome: 'granted'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'replayed'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'already_granted'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'grant_id_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'key_not_active' }
	| { outcome: 'owner_not_active' }
	| { outcome: 'integrity_error' };

/**
 * Grant listing is owner-scoped: only the key's own active instance-member
 * owner may enumerate its grant history. The organization-side revoke path
 * deliberately gets no listing surface in this slice, because enumerating every
 * key granted to an organization is a broader disclosure than revoking one
 * grant an operator already knows about.
 */
export interface ApiKeyOrganizationGrantListQuery {
	actor: ApiKeyActor;
	apiKeyId: string;
	cursor: string | null;
	limit: number;
}

export interface ApiKeyOrganizationGrantListPage {
	items: readonly ApiKeyOrganizationGrantMetadata[];
	nextCursor: string | null;
}

export type ListApiKeyOrganizationGrantsStoreResult =
	| { outcome: 'listed'; page: ApiKeyOrganizationGrantListPage }
	| { outcome: 'not_found' }
	| { outcome: 'owner_not_active' };

/**
 * One grant revocation attempt, carrying both admissible authorities.
 *
 * Revocation is de-escalation, so it is reachable two ways and the HTTP layer
 * proves each separately before the store ever sees it:
 *
 * - `ownerScope` is set when the caller presented a verified identity and is
 *   claiming to be the key's own owner. The store still re-proves that the
 *   actor is a currently active `instance_member` and actually owns the key, so
 *   an identity-only caller can never revoke a stranger's grant.
 * - `organizationScope` is set only when the caller proved current d6e-auth
 *   owner/admin authority over that exact organization through the session, and
 *   it is the session-selected organization -- never a free-form request field.
 *   An identity-only caller can therefore never choose an arbitrary
 *   organization, which is what keeps this path from becoming a way to revoke
 *   grants for organizations the caller has no authority over.
 *
 * When both paths are admissible the store resolves `key_owner` first, so the
 * recorded authority is deterministic rather than dependent on statement order.
 * Revocation deliberately does not require the key to still be live: retiring a
 * grant on an expired or revoked key is harmless and must never be blocked.
 */
export interface RevokeApiKeyOrganizationGrantCommand {
	actor: ApiKeyActor;
	idempotencyKey: string;
	requestFingerprint: string;
	apiKeyId: string;
	grantId: string;
	revokedAt: string;
	ownerScope: boolean;
	organizationScope: string | null;
}

/**
 * Provider-independent grant revoke outcomes.
 *
 * - `revoked`: this call stamped `revoked_at` plus the single revoke receipt.
 * - `replayed`: an exact replay under the original idempotency key, proven
 *   against the current grant row.
 * - `already_revoked`: a fresh idempotency key for an already revoked grant. No
 *   second receipt is written.
 * - `idempotency_conflict`: the key was reused for a different grant or a
 *   different request fingerprint.
 * - `not_found`: unknown grant, a grant that does not belong to the named key,
 *   or a grant the caller's proven authority does not reach. All reported
 *   identically, so neither path can enumerate the other's grants.
 * - `owner_not_active`: the owner-scope caller is missing or suspended. Only
 *   reachable when `organizationScope` did not also admit the request.
 * - `integrity_error`: the receipt and grant rows disagree.
 */
export type RevokeApiKeyOrganizationGrantStoreResult =
	| { outcome: 'revoked'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'replayed'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'already_revoked'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'owner_not_active' }
	| { outcome: 'integrity_error' };

export function boundApiKeyGrantListLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_API_KEY_GRANT_LIST_LIMIT);
}

export function isApiKeyGrantId(value: string): boolean {
	return API_KEY_GRANT_ID_PATTERN.test(value);
}

export function isApiKeyGrantingOrganizationRole(
	value: unknown
): value is ApiKeyGrantingOrganizationRole {
	return value === 'owner' || value === 'admin';
}

export function isApiKeyOrganizationGrantRevokeAuthority(
	value: unknown
): value is ApiKeyOrganizationGrantRevokeAuthority {
	return value === 'key_owner' || value === 'organization_admin';
}
