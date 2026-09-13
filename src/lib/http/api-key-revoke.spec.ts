import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	ApiKeyApplicationPort,
	RevokeApiKeyResult
} from '$lib/application/api-keys/api-key-service';
import type { ApiKeyMetadata } from '$lib/ports/api-key-store';
import { createApiKeyRevokeHandler, type ApiKeyRevokeApplicationResolver } from './api-key-revoke';

const KEY_ID: string = '01900000-0000-7000-8000-000000000201';

const metadata: ApiKeyMetadata = {
	id: KEY_ID,
	name: 'CI deploys',
	keyPrefix: 'signkit_abcdefgh',
	scopes: ['envelopes:read'],
	createdAt: '2026-09-12T00:00:00.000Z',
	expiresAt: '2026-12-11T00:00:00.000Z',
	lastUsedAt: null,
	revokedAt: '2026-09-13T00:00:00.000Z'
};

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: state,
		memberships: [],
		organizationId: null,
		principal:
			state === 'unavailable' || state === 'anonymous'
				? null
				: { subject: 'user-1', email: 'user@example.com', name: 'User' }
	};
}

/**
 * A defense-in-depth case: `unavailable` must fail closed even if a
 * principal is somehow present, since only `authorized` and
 * `no_active_organization` are the intended authenticated states.
 */
function unavailableLocalsWithPrincipal(): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: 'unavailable',
		memberships: [],
		organizationId: null,
		principal: { subject: 'user-1', email: 'user@example.com', name: 'User' }
	};
}

function event(input: {
	locals?: App.Locals;
	body?: string;
	headers?: HeadersInit;
	apiKeyId?: string;
}): RequestEvent {
	const id: string = input.apiKeyId ?? KEY_ID;
	const pathname: string = `/api/v1/api-keys/${id}/revoke`;
	const url: URL = new URL(`https://signkit.example${pathname}`);
	const headers: Headers = new Headers(input.headers);
	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	return {
		locals: input.locals ?? locals(),
		params: { apiKeyId: id },
		url,
		request: new Request(url, { method: 'POST', headers, body: input.body ?? '{}' })
	} as RequestEvent;
}

function application(result?: RevokeApiKeyResult): ApiKeyApplicationPort {
	return {
		createApiKey: vi.fn(),
		listApiKeys: vi.fn(),
		revokeApiKey: vi.fn(
			async (): Promise<RevokeApiKeyResult> => result ?? { outcome: 'revoked', key: metadata }
		),
		grantApiKeyOrganization: vi.fn(),
		listApiKeyOrganizationGrants: vi.fn(),
		revokeApiKeyOrganizationGrant: vi.fn()
	};
}

async function invoke(
	handler: (event: RequestEvent) => Response | Promise<Response>,
	requestEvent: RequestEvent
): Promise<Response> {
	return handler(requestEvent);
}

describe('API key revoke HTTP handler', () => {
	it('rejects anonymous callers before parsing or resolving dependencies', async () => {
		const resolver: ApiKeyRevokeApplicationResolver = vi.fn(
			(): ApiKeyApplicationPort | null => null
		);
		const response: Response = await invoke(
			createApiKeyRevokeHandler(resolver),
			event({ locals: locals('anonymous'), headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('fails closed with 503 when identity verification is unavailable', async () => {
		const resolver: ApiKeyRevokeApplicationResolver = vi.fn(
			(): ApiKeyApplicationPort | null => null
		);
		const response: Response = await invoke(
			createApiKeyRevokeHandler(resolver),
			event({ locals: locals('unavailable'), headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:identity-unavailable'
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('fails closed with 503 when unavailable even if a principal is present', async () => {
		const resolver: ApiKeyRevokeApplicationResolver = vi.fn(
			(): ApiKeyApplicationPort | null => null
		);
		const response: Response = await invoke(
			createApiKeyRevokeHandler(resolver),
			event({
				locals: unavailableLocalsWithPrincipal(),
				headers: { 'idempotency-key': 'revoke-1' }
			})
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:identity-unavailable'
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('does not require an active organization', async () => {
		const app: ApiKeyApplicationPort = application();
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({
				locals: locals('no_active_organization'),
				headers: { 'idempotency-key': 'revoke-1' }
			})
		);
		expect(response.status).toBe(200);
	});

	it('requires a bounded visible-ASCII Idempotency-Key', async () => {
		const app: ApiKeyApplicationPort = application();
		const handler = createApiKeyRevokeHandler((): ApiKeyApplicationPort => app);
		const missing: Response = await invoke(handler, event({}));
		const spaced: Response = await invoke(
			handler,
			event({ headers: { 'idempotency-key': 'has space' } })
		);
		const long: Response = await invoke(
			handler,
			event({ headers: { 'idempotency-key': 'x'.repeat(201) } })
		);
		expect(missing.status).toBe(400);
		expect(spaced.status).toBe(400);
		expect(long.status).toBe(400);
		expect(app.revokeApiKey).not.toHaveBeenCalled();
	});

	it('requires application/json content type', async () => {
		const app: ApiKeyApplicationPort = application();
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({ headers: { 'content-type': 'text/plain', 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(415);
		expect(app.revokeApiKey).not.toHaveBeenCalled();
	});

	it('rejects a nonempty body', async () => {
		const app: ApiKeyApplicationPort = application();
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({
				body: JSON.stringify({ reason: 'compromised' }),
				headers: { 'idempotency-key': 'revoke-1' }
			})
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:validation-failed'
		});
		expect(app.revokeApiKey).not.toHaveBeenCalled();
	});

	it('rejects oversized bodies', async () => {
		const app: ApiKeyApplicationPort = application();
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({
				body: JSON.stringify({ pad: 'x'.repeat(2048) }),
				headers: { 'idempotency-key': 'revoke-1' }
			})
		);
		expect(response.status).toBe(413);
		expect(app.revokeApiKey).not.toHaveBeenCalled();
	});

	it('rejects invalid JSON', async () => {
		const app: ApiKeyApplicationPort = application();
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({ body: '{', headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:invalid-json' });
	});

	it.each(['not-a-uuid', '', '../../etc/passwd'])(
		'forwards a malformed id unchanged, leaving not_found opacity to the store: %s',
		async (malformedId) => {
			const app: ApiKeyApplicationPort = application({ outcome: 'not_found' });
			const response: Response = await invoke(
				createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
				event({ apiKeyId: malformedId, headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(app.revokeApiKey).toHaveBeenCalledWith({ id: 'user-1' }, malformedId, {
				idempotencyKey: 'revoke-1'
			});
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:api-key-not-found'
			});
		}
	);

	it('scopes revoke to the authenticated identity only, without an organization', async () => {
		const app: ApiKeyApplicationPort = application();
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({ headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(200);
		expect(app.revokeApiKey).toHaveBeenCalledWith({ id: 'user-1' }, KEY_ID, {
			idempotencyKey: 'revoke-1'
		});
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body: { apiKey: ApiKeyMetadata } = await response.json();
		expect(body.apiKey.id).toBe(KEY_ID);
	});

	it('marks exact replays with the idempotency-replayed header', async () => {
		const app: ApiKeyApplicationPort = application({ outcome: 'replayed', key: metadata });
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({ headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
	});

	it('returns 200 without the replay header for a fresh key already revoked earlier', async () => {
		const app: ApiKeyApplicationPort = application({ outcome: 'already_revoked', key: metadata });
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({ headers: { 'idempotency-key': 'revoke-2' } })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBeNull();
	});

	it.each([
		['idempotency_conflict', 409, 'urn:signkit:problem:api-key-idempotency-conflict'],
		['not_found', 404, 'urn:signkit:problem:api-key-not-found'],
		['owner_not_active', 403, 'urn:signkit:problem:api-key-owner-not-active'],
		['integrity_error', 503, 'urn:signkit:problem:api-key-integrity-error']
	] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
		const app: ApiKeyApplicationPort = application({ outcome });
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): ApiKeyApplicationPort => app),
			event({ headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ type, status });
	});

	it('fails closed with 503 when persistence is not wired', async () => {
		const response: Response = await invoke(
			createApiKeyRevokeHandler((): null => null),
			event({ headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:persistence-unavailable'
		});
	});

	it('returns 503 when application resolution throws', async () => {
		const response: Response = await invoke(
			createApiKeyRevokeHandler(async () => {
				throw new Error('unavailable');
			}),
			event({ headers: { 'idempotency-key': 'revoke-1' } })
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:persistence-unavailable'
		});
	});
});
