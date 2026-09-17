import type {
	ApiKeyAuthenticationStore,
	ApiKeyPrincipal
} from '$lib/ports/api-key-authentication-store';
import { hashApiKey, isApiKey } from '$lib/security/api-key';

export interface ApiKeyAuthenticationInput {
	/** The already-parsed bearer token. Re-validated here as defense in depth. */
	token: string;
}

/**
 * Public authentication outcomes.
 *
 * The opaque `invalid_token` covers an unknown, revoked, or expired key and
 * a suspended owner as one indistinguishable case.
 */
export type ApiKeyAuthenticationResult =
	| { outcome: 'authenticated'; principal: ApiKeyPrincipal }
	| { outcome: 'invalid_token' }
	| { outcome: 'rate_limited' }
	| { outcome: 'integrity_error' };

export interface ApiKeyAuthenticationPort {
	authenticate(input: ApiKeyAuthenticationInput): Promise<ApiKeyAuthenticationResult>;
}

/**
 * Request-path API key authentication.
 *
 * The service owns exactly two things: hashing the presented token and
 * delegating one snapshot read to the store. It holds no state and caches
 * nothing, which is what makes key revocation effective on the next request
 * rather than after some unspecified expiry.
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
		// The hooks layer already parsed the bearer, but a service must never
		// trust its caller to have done so: an unparsable token resolves to the
		// same opaque outcome as an unknown one rather than throwing.
		if (!isApiKey(input.token)) return { outcome: 'invalid_token' };

		const tokenHash: string = await hashApiKey(input.token);
		const result = await this.store.authenticateApiKey({
			tokenHash,
			at: this.now().toISOString()
		});
		return result;
	}
}
