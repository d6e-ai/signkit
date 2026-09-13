import type { ApiKeyScope } from '$lib/security/api-key';

/**
 * The request header that names the single d6e organization an agent request is
 * asking to act within.
 *
 * It is mandatory for every API-key-authenticated request and is never inferred.
 * A key holding exactly one live grant still has to name it, and a key holding
 * several reaches only the one it asked for. Nothing about the browser
 * organization cookie, the grant insertion order, or a "first" or "only" grant
 * participates in this decision: silent inference is precisely the failure mode
 * that would let a key act in a tenant its caller never intended.
 */
export const SIGNKIT_ORGANIZATION_HEADER: string = 'signkit-organization-id';

/**
 * Bound for the organization selector. This is an external d6e-auth identifier
 * that SignKit only projects, so it is deliberately not a UUIDv7 check -- it
 * matches the `organization_id` bounds the grant tables enforce in SQL
 * (1..200 printable ASCII) and nothing narrower.
 */
export const ORGANIZATION_SELECTOR_PATTERN: RegExp = /^[!-~]{1,200}$/;

export function isOrganizationSelector(value: string | null): value is string {
	return value !== null && ORGANIZATION_SELECTOR_PATTERN.test(value);
}

/**
 * The authority an authenticated API key request carries.
 *
 * `organizationId` is the organization the caller explicitly requested and that
 * a live grant proved, never a default. `scopes` are the key's own canonical
 * scopes; the grant contributes the organization and never widens scope, so a
 * handler's authority is always the intersection of these scopes with this one
 * organization.
 *
 * There is deliberately no token, token hash, or secret-derived value here
 * beyond the non-secret display `keyPrefix`, and no human name or email: an
 * API key principal is a machine actor with no human identity attached.
 */
export interface ApiKeyPrincipal {
	apiKeyId: string;
	keyPrefix: string;
	ownerUserId: string;
	organizationId: string;
	organizationName: string;
	scopes: readonly ApiKeyScope[];
	expiresAt: string;
}

/**
 * Provider-independent authentication outcomes.
 *
 * - `authenticated`: the token resolved a live key, an active owner, canonical
 *   scopes, a live grant for the requested organization, and that
 *   organization's projection, all in one snapshot.
 * - `invalid_token`: one opaque outcome covering an unknown token hash, a
 *   revoked key, an expired key, and a suspended or missing owner. These are
 *   never distinguished, so the endpoint cannot be used as an existence or
 *   status oracle for a credential the caller does not already hold.
 * - `organization_grant_required`: the key itself is live and its owner is
 *   active, but no live grant exists for the organization the request named.
 *   This is deliberately distinguishable from `invalid_token`: it reports only
 *   the caller's own authority over a credential they are already holding, and
 *   collapsing it into the opaque outcome would leave a correctly configured
 *   agent with no way to tell a missing grant from a bad token.
 * - `integrity_error`: the snapshot contradicted itself -- non-canonical stored
 *   scopes, more than one live grant for the requested pair, or a granted
 *   organization with no projection row. Never a silent downgrade to
 *   unauthenticated.
 */
export type AuthenticateApiKeyResult =
	| { outcome: 'authenticated'; principal: ApiKeyPrincipal }
	| { outcome: 'invalid_token' }
	| { outcome: 'organization_grant_required' }
	| { outcome: 'integrity_error' };

export interface AuthenticateApiKeyQuery {
	/** SHA-256 of the presented token. The plaintext never reaches this port. */
	tokenHash: string;
	/** The organization the request explicitly named. Never defaulted. */
	organizationId: string;
	/** Caller-supplied instant, so liveness is evaluated against an injected clock. */
	at: string;
}

/**
 * Request-path resolution of an API key into an organization-scoped authority.
 *
 * Implementations must answer from one durable snapshot -- a single statement,
 * not a sequence of reads -- so a key revocation, an owner suspension, or a
 * grant revocation committing mid-resolution can never produce a principal
 * assembled from two different points in time. Nothing here may be cached:
 * every request re-reads the token hash, key liveness and expiry, owner status,
 * canonical scopes, the requested live grant, and the organization projection,
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
