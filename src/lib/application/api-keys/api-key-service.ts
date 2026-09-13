import {
	boundApiKeyGrantListLimit,
	boundApiKeyListLimit,
	isApiKeyGrantId,
	isApiKeyId,
	isApiKeyIdempotencyKey,
	type ApiKeyGrantingOrganizationRole,
	type ApiKeyOrganizationGrantMetadata,
	type CreateApiKeyStoreResult,
	type GrantApiKeyOrganizationStoreResult,
	type ListApiKeyOrganizationGrantsStoreResult,
	type ListApiKeyStoreResult,
	type RevokeApiKeyOrganizationGrantStoreResult,
	type RevokeApiKeyStoreResult,
	type ApiKeyListQuery,
	type ApiKeyMetadata,
	type ApiKeyStore
} from '$lib/ports/api-key-store';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import {
	canonicalizeApiKeyScopes,
	issueApiKey,
	resolveApiKeyExpiresAt,
	validateApiKeyName,
	type IssuedApiKey,
	type ApiKeyScope
} from '$lib/security/api-key';

/**
 * A create attempt only repeats when the store reports that the generated UUID
 * or the credential hash already exists. Both are astronomically unlikely, so a
 * small bound is enough to absorb them without masking a real fault.
 */
const MAX_CREDENTIAL_ATTEMPTS: number = 3;

/** d6e-auth subject that must match a currently active local instance member. */
export interface ApiKeyRequestActor {
	id: string;
}

export interface CreateApiKeyInput {
	idempotencyKey: string;
	name: string;
	scopes: readonly string[];
	/** Omit for the 90 day default. `null` is rejected: API keys must expire. */
	expiresAt?: string | null;
}

export interface RevokeApiKeyInput {
	idempotencyKey: string;
}

/**
 * Public create outcomes.
 *
 * `created` is the only outcome that carries the plaintext `signkit_` secret, and
 * it is returned exactly once, in memory. An exact idempotent replay resolves to
 * `already_issued` with metadata only: the original secret is unrecoverable and
 * a replacement is never minted or revealed. Invited and suspended owners fail
 * closed as `owner_not_active`.
 */
export type CreateApiKeyResult =
	| { outcome: 'created'; key: ApiKeyMetadata; token: string }
	| { outcome: 'already_issued'; key: ApiKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'owner_not_active' }
	| { outcome: 'integrity_error' };

export type ListApiKeyResult = ListApiKeyStoreResult;

/** Public revoke outcomes. Unknown and cross-owner keys are both `not_found`. */
export type RevokeApiKeyResult =
	| { outcome: 'revoked'; key: ApiKeyMetadata }
	| { outcome: 'replayed'; key: ApiKeyMetadata }
	| { outcome: 'already_revoked'; key: ApiKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'owner_not_active' }
	| { outcome: 'integrity_error' };

/**
 * One grant request.
 *
 * `organizationId`, `organizationName`, and `grantingOrganizationRole` all come
 * from the caller's own verified d6e-auth membership for the session-selected
 * organization -- never from a request body. Accepting a free-form organization
 * here would turn the endpoint into a way to grant access to an organization the
 * caller has no authority over, which is the single most important thing this
 * surface must not permit.
 */
export interface GrantApiKeyOrganizationInput {
	idempotencyKey: string;
	organizationId: string;
	organizationName: string;
	grantingOrganizationRole: ApiKeyGrantingOrganizationRole;
}

export interface ApiKeyOrganizationGrantListInput {
	cursor: string | null;
	limit: number;
}

/**
 * One grant revocation request, carrying whichever de-escalation authorities the
 * HTTP layer proved.
 *
 * `ownerScope` means a verified identity is claiming to own the key; the store
 * still re-proves active instance membership and actual ownership.
 * `organizationScope`, when set, is the session-selected organization the caller
 * proved current d6e owner/admin authority over -- never a caller-chosen value.
 * At least one must be present or the request cannot be authorized at all.
 */
export interface RevokeApiKeyOrganizationGrantInput {
	idempotencyKey: string;
	ownerScope: boolean;
	organizationScope: string | null;
}

export type GrantApiKeyOrganizationResult =
	| { outcome: 'granted'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'replayed'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'already_granted'; grant: ApiKeyOrganizationGrantMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'key_not_active' }
	| { outcome: 'owner_not_active' }
	| { outcome: 'integrity_error' };

export type ListApiKeyOrganizationGrantsResult = ListApiKeyOrganizationGrantsStoreResult;

export type RevokeApiKeyOrganizationGrantResult = RevokeApiKeyOrganizationGrantStoreResult;

export interface ApiKeyApplicationPort {
	createApiKey(actor: ApiKeyRequestActor, input: CreateApiKeyInput): Promise<CreateApiKeyResult>;
	listApiKeys(actor: ApiKeyRequestActor, query: ApiKeyListQuery): Promise<ListApiKeyResult>;
	revokeApiKey(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		input: RevokeApiKeyInput
	): Promise<RevokeApiKeyResult>;
	grantApiKeyOrganization(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		input: GrantApiKeyOrganizationInput
	): Promise<GrantApiKeyOrganizationResult>;
	listApiKeyOrganizationGrants(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		input: ApiKeyOrganizationGrantListInput
	): Promise<ListApiKeyOrganizationGrantsResult>;
	revokeApiKeyOrganizationGrant(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		grantId: string,
		input: RevokeApiKeyOrganizationGrantInput
	): Promise<RevokeApiKeyOrganizationGrantResult>;
}

/** Rejected before any durable work, so no partial state can be observed. */
export class InvalidApiKeyRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidApiKeyRequestError';
	}
}

/**
 * Owner-scoped SignKit API key management.
 *
 * The service owns request normalization, the request fingerprint, credential
 * generation, and the bounded collision retry. The fingerprint covers only the
 * caller's normalized request — canonical name, canonical scopes, and the
 * requested expiry as asked for rather than as resolved — so a retry after a
 * lost response hashes identically and replays instead of conflicting. The
 * durable store requires the actor to be an active instance member; this slice
 * never accepts an organization id and never grants cross-organization access.
 */
export class ApiKeyApplication implements ApiKeyApplicationPort {
	constructor(
		private readonly store: ApiKeyStore,
		private readonly now: () => Date = (): Date => new Date(),
		private readonly issue: () => Promise<IssuedApiKey> = issueApiKey,
		private readonly newId: UuidV7Generator = newUuidV7
	) {}

	async createApiKey(
		actor: ApiKeyRequestActor,
		input: CreateApiKeyInput
	): Promise<CreateApiKeyResult> {
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		const name: string = normalize(
			(): string => validateApiKeyName(input.name),
			'Invalid API key name'
		);
		const scopes: readonly ApiKeyScope[] = normalize(
			(): readonly ApiKeyScope[] => canonicalizeApiKeyScopes(input.scopes),
			'API key scopes must be a nonempty unique subset'
		);
		const now: Date = this.now();
		const expiresAt: string = normalize(
			(): string => resolveApiKeyExpiresAt(now, input.expiresAt),
			'Invalid API key expiry'
		);
		const createdAt: string = now.toISOString();
		const requestFingerprint: string = await sha256(
			JSON.stringify({
				expiresAt: input.expiresAt === undefined ? null : expiresAt,
				name,
				scopes
			})
		);

		for (let attempt: number = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
			const apiKeyId: string = this.newId();
			if (!isApiKeyId(apiKeyId)) {
				throw new Error('Generated API key id is not a canonical UUIDv7');
			}
			const issued: IssuedApiKey = await this.issue();
			const result: CreateApiKeyStoreResult = await this.store.createApiKey({
				actor: { type: 'user', id: actor.id },
				idempotencyKey,
				requestFingerprint,
				apiKeyId,
				name,
				scopes,
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix,
				createdAt,
				expiresAt
			});
			switch (result.outcome) {
				case 'created':
					return { outcome: 'created', key: result.key, token: issued.token };
				case 'key_id_conflict':
				case 'token_hash_conflict':
					continue;
				default:
					return result;
			}
		}

		throw new Error('API key credential generation exhausted its collision retries');
	}

	async listApiKeys(actor: ApiKeyRequestActor, query: ApiKeyListQuery): Promise<ListApiKeyResult> {
		// A malformed cursor can never identify a key row, so the store's own
		// cursor resolution fails it closed to an empty page exactly like an
		// unknown or cross-owner cursor. It is never rejected locally: the store
		// must always authorize the owner first, even for a cursor that can never
		// match, so an inactive owner still receives `owner_not_active`.
		return await this.store.listApiKeys(
			{ type: 'user', id: actor.id },
			{
				cursor: query.cursor,
				limit: boundApiKeyListLimit(query.limit)
			}
		);
	}

	async revokeApiKey(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		input: RevokeApiKeyInput
	): Promise<RevokeApiKeyResult> {
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		// An id that cannot exist is answered opaquely, never as a validation hint.
		if (!isApiKeyId(apiKeyId)) return { outcome: 'not_found' };
		const requestFingerprint: string = await sha256(JSON.stringify({ apiKeyId }));
		const result: RevokeApiKeyStoreResult = await this.store.revokeApiKey({
			actor: { type: 'user', id: actor.id },
			idempotencyKey,
			requestFingerprint,
			apiKeyId,
			revokedAt: this.now().toISOString()
		});
		return result;
	}

	async grantApiKeyOrganization(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		input: GrantApiKeyOrganizationInput
	): Promise<GrantApiKeyOrganizationResult> {
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		// An id that cannot exist is answered opaquely, never as a validation hint.
		if (!isApiKeyId(apiKeyId)) return { outcome: 'not_found' };
		const grantedAt: string = this.now().toISOString();
		// The fingerprint covers only what the caller asked for: which key, which
		// organization. The granting role is evidence recorded alongside the grant,
		// not part of the request identity -- a caller promoted from admin to owner
		// between a lost response and its retry must still replay rather than
		// conflict.
		const requestFingerprint: string = await sha256(
			JSON.stringify({ apiKeyId, organizationId: input.organizationId })
		);

		for (let attempt: number = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
			const grantId: string = this.newId();
			if (!isApiKeyGrantId(grantId)) {
				throw new Error('Generated API key grant id is not a canonical UUIDv7');
			}
			const result: GrantApiKeyOrganizationStoreResult = await this.store.grantApiKeyOrganization({
				actor: { type: 'user', id: actor.id },
				idempotencyKey,
				requestFingerprint,
				grantId,
				apiKeyId,
				organizationId: input.organizationId,
				organizationName: input.organizationName,
				grantingOrganizationRole: input.grantingOrganizationRole,
				grantedAt
			});
			if (result.outcome === 'grant_id_conflict') continue;
			return result;
		}

		throw new Error('API key grant id generation exhausted its collision retries');
	}

	async listApiKeyOrganizationGrants(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		input: ApiKeyOrganizationGrantListInput
	): Promise<ListApiKeyOrganizationGrantsResult> {
		if (!isApiKeyId(apiKeyId)) return { outcome: 'not_found' };
		// A malformed cursor is forwarded unvalidated, matching the key list: the
		// store must authorize the owner before a cursor can be resolved, so a
		// cursor that can never match fails closed there rather than here.
		return await this.store.listApiKeyOrganizationGrants({
			actor: { type: 'user', id: actor.id },
			apiKeyId,
			cursor: input.cursor,
			limit: boundApiKeyGrantListLimit(input.limit)
		});
	}

	async revokeApiKeyOrganizationGrant(
		actor: ApiKeyRequestActor,
		apiKeyId: string,
		grantId: string,
		input: RevokeApiKeyOrganizationGrantInput
	): Promise<RevokeApiKeyOrganizationGrantResult> {
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		// Neither authority proven means nothing can authorize this, and it is
		// reported as the same opaque outcome as an unknown grant rather than as a
		// distinct "you have no authority" hint.
		if (!input.ownerScope && input.organizationScope === null) return { outcome: 'not_found' };
		if (!isApiKeyId(apiKeyId) || !isApiKeyGrantId(grantId)) return { outcome: 'not_found' };
		const requestFingerprint: string = await sha256(JSON.stringify({ apiKeyId, grantId }));
		return await this.store.revokeApiKeyOrganizationGrant({
			actor: { type: 'user', id: actor.id },
			idempotencyKey,
			requestFingerprint,
			apiKeyId,
			grantId,
			revokedAt: this.now().toISOString(),
			ownerScope: input.ownerScope,
			organizationScope: input.organizationScope
		});
	}
}

function assertIdempotencyKey(idempotencyKey: string): string {
	if (!isApiKeyIdempotencyKey(idempotencyKey)) {
		throw new InvalidApiKeyRequestError('Invalid API key idempotency key');
	}
	return idempotencyKey;
}

function normalize<T>(normalizer: () => T, fallbackMessage: string): T {
	try {
		return normalizer();
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : fallbackMessage;
		throw new InvalidApiKeyRequestError(message);
	}
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
