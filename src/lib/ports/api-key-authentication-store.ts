import type { ApiKeyScope } from '$lib/security/api-key';

/**
 * The authority an authenticated API key request carries.
 *
 * One deployment database is the sole SignKit instance boundary, so an API
 * key authenticates instance-wide: a live key plus an active owner plus
 * scopes, with no per-request tenant selector. `scopes` are the key's own
 * canonical scopes.
 *
 * There is deliberately no token, token hash, or secret-derived value here
 * beyond the non-secret display `keyPrefix`, and no human name or email: an
 * API key principal is a machine actor with no human identity attached.
 */
export interface ApiKeyPrincipal {
	apiKeyId: string;
	keyPrefix: string;
	ownerUserId: string;
	scopes: readonly ApiKeyScope[];
	expiresAt: string;
}

/**
 * Provider-independent authentication outcomes.
 *
 * - `authenticated`: the token resolved a live key, an active owner, and
 *   canonical scopes, all in one snapshot.
 * - `invalid_token`: one opaque outcome covering an unknown token hash, a
 *   revoked key, an expired key, and a suspended or missing owner. These are
 *   never distinguished, so the endpoint cannot be used as an existence or
 *   status oracle for a credential the caller does not already hold.
 * - `rate_limited`: the key authenticated, but the durable per-key window is
 *   exhausted. Distinct from invalid_token so a correctly configured agent can
 *   back off without treating the key as revoked.
 * - `integrity_error`: the snapshot contradicted itself -- non-canonical stored
 *   scopes or more than one row for the token hash. Never a silent downgrade
 *   to unauthenticated.
 */
export type AuthenticateApiKeyResult =
	| { outcome: 'authenticated'; principal: ApiKeyPrincipal }
	| { outcome: 'invalid_token' }
	| { outcome: 'rate_limited' }
	| { outcome: 'integrity_error' };

export interface AuthenticateApiKeyQuery {
	/** SHA-256 of the presented token. The plaintext never reaches this port. */
	tokenHash: string;
	/** Caller-supplied instant, so liveness is evaluated against an injected clock. */
	at: string;
}

/**
 * Request-path resolution of an API key into an instance authority.
 *
 * Implementations must answer from one durable snapshot -- a single statement,
 * not a sequence of reads -- so a key revocation or an owner suspension
 * committing mid-resolution can never produce a principal assembled from two
 * different points in time. Nothing here may be cached: every request re-reads
 * the token hash, key liveness and expiry, owner status, and canonical scopes,
 * which is what makes revocation on either side effective on the very next
 * request.
 *
 * Implementations must look the key up by `token_hash` only. `key_prefix` is
 * display material shared by design across many keys and is never a lookup
 * term. No implementation may log, return, or persist the presented token or
 * its hash.
 */
export interface ApiKeyAuthenticationStore {
	authenticateApiKey(query: AuthenticateApiKeyQuery): Promise<AuthenticateApiKeyResult>;
}
