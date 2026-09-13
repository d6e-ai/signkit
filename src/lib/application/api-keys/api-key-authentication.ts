import {
	isOrganizationSelector,
	type ApiKeyAuthenticationStore,
	type ApiKeyPrincipal,
	type AuthenticateApiKeyResult
} from '$lib/ports/api-key-authentication-store';
import { hashApiKey, isApiKey } from '$lib/security/api-key';

export interface ApiKeyAuthenticationInput {
	/** The already-parsed bearer token. Re-validated here as defense in depth. */
	token: string;
	/** The organization the request explicitly named, unvalidated. */
	organizationId: string | null;
}

/**
 * Public authentication outcomes.
 *
 * `organization_selector_invalid` is decided before any durable read, so a
 * request that forgot the selector or sent a malformed one learns nothing at all
 * about whether its token would otherwise have worked. Every remaining outcome
 * mirrors the store's, and the opaque `invalid_token` still covers an unknown,
 * revoked, or expired key and a suspended owner as one indistinguishable case.
 */
export type ApiKeyAuthenticationResult =
	| { outcome: 'authenticated'; principal: ApiKeyPrincipal }
	| { outcome: 'invalid_token' }
	| { outcome: 'organization_selector_invalid' }
	| { outcome: 'organization_grant_required' }
	| { outcome: 'integrity_error' };

export interface ApiKeyAuthenticationPort {
	authenticate(input: ApiKeyAuthenticationInput): Promise<ApiKeyAuthenticationResult>;
}

/**
 * Request-path API key authentication.
 *
 * The service owns exactly three things: validating the selector before any
 * durable work, hashing the presented token, and delegating one snapshot read to
 * the store. It holds no state and caches nothing, which is what makes key and
 * grant revocation effective on the next request rather than after some
 * unspecified expiry.
 *
 * Validation order is deliberate. The organization selector is checked first,
 * because a missing or malformed selector is a request-shape error that must be
 * answerable without disclosing anything about the credential; only then is the
 * token hashed and resolved. Reversing that order would turn the selector error
 * into an oracle for token validity.
 *
 * Neither the token nor its hash is logged, returned, or retained anywhere in
 * this path.
 */
export class ApiKeyAuthenticationApplication implements ApiKeyAuthenticationPort {
	constructor(
		private readonly store: ApiKeyAuthenticationStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async authenticate(input: ApiKeyAuthenticationInput): Promise<ApiKeyAuthenticationResult> {
		if (!isOrganizationSelector(input.organizationId)) {
			return { outcome: 'organization_selector_invalid' };
		}
		// The hooks layer already parsed the bearer, but a service must never
		// trust its caller to have done so: an unparsable token resolves to the
		// same opaque outcome as an unknown one rather than throwing.
		if (!isApiKey(input.token)) return { outcome: 'invalid_token' };

		const tokenHash: string = await hashApiKey(input.token);
		const result: AuthenticateApiKeyResult = await this.store.authenticateApiKey({
			tokenHash,
			organizationId: input.organizationId,
			at: this.now().toISOString()
		});
		return result;
	}
}
