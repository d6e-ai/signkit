import type { RequestEvent } from '@sveltejs/kit';

const ORIGIN: string = 'https://signkit.example';

/**
 * Builds `App.Locals` for an organization-scoped request. `authorized` gets a
 * single owner membership in "Workspace" joined at the fixed seed timestamp;
 * every other identity state gets empty memberships and a null organization
 * and principal, matching how the real authorization middleware fails closed.
 * `organizationId` is required so a caller can never silently fall back to an
 * authorized default organization.
 */
export function organizationScopedLocals(
	state: App.Locals['identityState'],
	organizationId: string
): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: state,
		memberships:
			state === 'authorized'
				? [
						{
							joinedAt: '2026-09-11T00:00:00.000Z',
							role: 'owner',
							organization: {
								id: organizationId,
								name: 'Workspace',
								slug: 'workspace',
								status: 'active'
							}
						}
					]
				: [],
		organizationId: state === 'authorized' ? organizationId : null,
		principal:
			state === 'authorized' ? { subject: 'user-1', email: 'user@example.com', name: 'User' } : null
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
