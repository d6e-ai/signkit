import type { RequestEvent } from '@sveltejs/kit';
import type { VerifiedPrincipal } from '$lib/server/d6e-auth';

const ORIGIN: string = 'https://signkit.example';

/**
 * Builds `App.Locals` for an instance-scoped request. `active` gets an active
 * owner membership for the fixed seed user; every other identity state gets a
 * null membership, matching how the real authorization middleware fails
 * closed.
 */
export function instanceScopedLocals(state: App.Locals['identityState']): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: state,
		instanceMembership:
			state === 'active' ? { userId: 'user-1', role: 'owner', status: 'active' } : null,
		bootstrapped: true,
		principal:
			state === 'active' ? { subject: 'user-1', email: 'user@example.com', name: 'User' } : null
	};
}

/**
 * Builds `App.Locals` for an instance-level request that carries no active
 * membership (instance bootstrap/membership, API-key management).
 * `unavailable`, `anonymous`, and `suspended` are the only states with no
 * principal; every other state gets the same fixed user, since these surfaces
 * authorize on identity alone, never on membership or API-key state.
 */
export function identityOnlyLocals(
	state: App.Locals['identityState'] = 'active',
	principalOverrides: Partial<VerifiedPrincipal> = {}
): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: state,
		instanceMembership: null,
		bootstrapped: true,
		principal:
			state === 'unavailable' || state === 'anonymous' || state === 'suspended'
				? null
				: { subject: 'user-1', email: 'user@example.com', name: 'User', ...principalOverrides }
	};
}

/**
 * A defense-in-depth fixture: `unavailable` must fail closed even if a
 * principal is somehow present, since only `active` and `no_membership` are
 * the intended authenticated states.
 */
export function unavailableIdentityLocalsWithPrincipal(): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: 'unavailable',
		instanceMembership: null,
		bootstrapped: true,
		principal: { subject: 'user-1', email: 'user@example.com', name: 'User' }
	};
}

export interface HttpRequestEventInput {
	pathname: string;
	method?: string;
	body?: BodyInit;
	headers?: HeadersInit;
	locals: App.Locals;
	params?: Record<string, string>;
	search?: string;
	platform?: App.Platform;
	/**
	 * Opt-in only: when true, sets `content-type: application/json` if a body
	 * is present and the caller did not already set a content type.
	 */
	jsonBodyContentType?: boolean;
}

/** Builds a `RequestEvent` against `https://signkit.example` for HTTP handler specs. */
export function createHttpRequestEvent(input: HttpRequestEventInput): RequestEvent {
	const url: URL = new URL(`${ORIGIN}${input.pathname}${input.search ?? ''}`);
	const headers: Headers = new Headers(input.headers);
	if (input.jsonBodyContentType && input.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	return {
		locals: input.locals,
		params: input.params ?? {},
		...(input.platform !== undefined ? { platform: input.platform } : {}),
		request: new Request(url, {
			method: input.method ?? 'GET',
			headers,
			body: input.body
		}),
		url
	} as RequestEvent;
}
