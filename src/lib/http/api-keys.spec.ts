import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	InvalidApiKeyRequestError,
	type ApiKeyApplicationPort,
	type CreateApiKeyResult,
	type ListApiKeyResult
} from '$lib/application/api-keys/api-key-service';
import type { ApiKeyMetadata } from '$lib/ports/api-key-store';
import {
	identityOnlyLocals as locals,
	unavailableIdentityLocalsWithPrincipal
} from './http-handler-test-support';
import { createApiKeyHttpHandlers, type ApiKeyApplicationResolver } from './api-keys';

const KEY_ID: string = '01900000-0000-7000-8000-000000000201';

const metadata: ApiKeyMetadata = {
	id: KEY_ID,
	name: 'CI deploys',
	keyPrefix: 'signkit_abcdefgh',
	scopes: ['envelopes:read'],
	createdAt: '2026-09-12T00:00:00.000Z',
	expiresAt: '2026-12-11T00:00:00.000Z',
	lastUsedAt: null,
	revokedAt: null
};

function event(input: {
	locals?: App.Locals;
	method?: string;
	body?: string;
	headers?: HeadersInit;
	search?: string;
}): RequestEvent {
	const pathname: string = '/api/v1/api-keys';
	const url: URL = new URL(`https://signkit.example${pathname}${input.search ?? ''}`);
	const headers: Headers = new Headers(input.headers);
	if (input.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	return {
		locals: input.locals ?? locals(),
		params: {},
		request: new Request(url, { method: input.method ?? 'GET', headers, body: input.body }),
		url
	} as RequestEvent;
}

function application(): ApiKeyApplicationPort {
	return {
		createApiKey: vi.fn(async (): Promise<CreateApiKeyResult> => ({
			outcome: 'created',
			key: metadata,
			token: 'signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
		})),
		listApiKeys: vi.fn(async (): Promise<ListApiKeyResult> => ({
			outcome: 'listed',
			page: { items: [metadata], nextCursor: null }
		})),
		revokeApiKey: vi.fn(),
		grantApiKeyOrganization: vi.fn(),
		listApiKeyOrganizationGrants: vi.fn(),
		revokeApiKeyOrganizationGrant: vi.fn()
	};
}

function validBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ name: 'CI deploys', scopes: ['envelopes:read'], ...overrides });
}

async function invoke(
	handler: (event: RequestEvent) => Response | Promise<Response>,
	requestEvent: RequestEvent
): Promise<Response> {
	return handler(requestEvent);
}

describe('API key HTTP handlers', () => {
	describe('create', () => {
		it('rejects anonymous callers before parsing or resolving dependencies', async () => {
			const resolver: ApiKeyApplicationResolver = vi.fn((): ApiKeyApplicationPort | null => null);
			const response: Response = await invoke(
				createApiKeyHttpHandlers(resolver).create,
				event({
					locals: locals('anonymous'),
					method: 'POST',
					body: validBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:authentication-required'
			});
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when identity verification is unavailable', async () => {
			const resolver: ApiKeyApplicationResolver = vi.fn((): ApiKeyApplicationPort | null => null);
			const response: Response = await invoke(
				createApiKeyHttpHandlers(resolver).create,
				event({
					locals: locals('unavailable'),
					method: 'POST',
					body: validBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:identity-unavailable'
			});
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when unavailable even if a principal is present', async () => {
			const resolver: ApiKeyApplicationResolver = vi.fn((): ApiKeyApplicationPort | null => null);
			const response: Response = await invoke(
				createApiKeyHttpHandlers(resolver).create,
				event({
					locals: unavailableIdentityLocalsWithPrincipal(),
					method: 'POST',
					body: validBody(),
					headers: { 'idempotency-key': 'create-1' }
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
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({
					locals: locals('no_active_organization'),
					method: 'POST',
					body: validBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(201);
		});

		it('requires a bounded visible-ASCII Idempotency-Key', async () => {
			const app: ApiKeyApplicationPort = application();
			const handler = createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create;
			const missing: Response = await invoke(handler, event({ method: 'POST', body: validBody() }));
			const spaced: Response = await invoke(
				handler,
				event({ method: 'POST', body: validBody(), headers: { 'idempotency-key': 'has space' } })
			);
			const long: Response = await invoke(
				handler,
				event({
					method: 'POST',
					body: validBody(),
					headers: { 'idempotency-key': 'x'.repeat(201) }
				})
			);
			expect(missing.status).toBe(400);
			expect(spaced.status).toBe(400);
			expect(long.status).toBe(400);
			expect(app.createApiKey).not.toHaveBeenCalled();
		});

		it('requires application/json content type', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({
					method: 'POST',
					body: validBody(),
					headers: { 'content-type': 'text/plain', 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(415);
			expect(app.createApiKey).not.toHaveBeenCalled();
		});

		it('rejects request bodies larger than the bounded JSON limit', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({
					method: 'POST',
					body: validBody({ name: 'x'.repeat(5 * 1024) }),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(413);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:request-body-too-large'
			});
			expect(app.createApiKey).not.toHaveBeenCalled();
		});

		it('rejects invalid JSON', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({ method: 'POST', body: '{', headers: { 'idempotency-key': 'create-1' } })
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:invalid-json' });
		});

		it('rejects unknown fields and malformed shapes with a validation problem', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({
					method: 'POST',
					body: validBody({ organizationId: 'attacker-organization' }),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
			expect(app.createApiKey).not.toHaveBeenCalled();
		});

		it('translates an invalid normalized request into a validation problem', async () => {
			const app: ApiKeyApplicationPort = application();
			(app.createApiKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new InvalidApiKeyRequestError('API key scopes must be a nonempty unique subset')
			);
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({
					method: 'POST',
					body: validBody({ scopes: ['not-a-real-scope'] }),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('scopes create to the authenticated identity only, without an organization', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({
					method: 'POST',
					body: validBody({ expiresAt: '2026-12-01T00:00:00.000Z' }),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(201);
			expect(app.createApiKey).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{
					idempotencyKey: 'create-1',
					name: 'CI deploys',
					scopes: ['envelopes:read'],
					expiresAt: '2026-12-01T00:00:00.000Z'
				}
			);
			const body: { apiKey: ApiKeyMetadata; token: string } = await response.json();
			expect(body.token).toBe('signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
			expect(body.apiKey.id).toBe(KEY_ID);
			expect(response.headers.get('cache-control')).toBe('no-store');
		});

		it('returns only metadata, without the plaintext token, on an exact replay', async () => {
			const app: ApiKeyApplicationPort = application();
			(app.createApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'already_issued',
				key: metadata
			} satisfies CreateApiKeyResult);
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({ method: 'POST', body: validBody(), headers: { 'idempotency-key': 'create-1' } })
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBe('true');
			const body: Record<string, unknown> = await response.json();
			expect(body).not.toHaveProperty('token');
		});

		it.each([
			['idempotency_conflict', 409, 'urn:signkit:problem:api-key-idempotency-conflict'],
			['owner_not_active', 403, 'urn:signkit:problem:api-key-owner-not-active'],
			['integrity_error', 503, 'urn:signkit:problem:api-key-integrity-error']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: ApiKeyApplicationPort = application();
			(app.createApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome
			} satisfies CreateApiKeyResult);
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).create,
				event({ method: 'POST', body: validBody(), headers: { 'idempotency-key': 'create-1' } })
			);
			expect(response.status).toBe(status);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toMatchObject({ type, status });
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): null => null).create,
				event({ method: 'POST', body: validBody(), headers: { 'idempotency-key': 'create-1' } })
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});
	});

	describe('list', () => {
		it('rejects anonymous callers before resolving dependencies', async () => {
			const resolver: ApiKeyApplicationResolver = vi.fn((): ApiKeyApplicationPort | null => null);
			const response: Response = await invoke(
				createApiKeyHttpHandlers(resolver).list,
				event({ locals: locals('anonymous') })
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when identity verification is unavailable', async () => {
			const resolver: ApiKeyApplicationResolver = vi.fn((): ApiKeyApplicationPort | null => null);
			const response: Response = await invoke(
				createApiKeyHttpHandlers(resolver).list,
				event({ locals: locals('unavailable') })
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:identity-unavailable'
			});
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when unavailable even if a principal is present', async () => {
			const resolver: ApiKeyApplicationResolver = vi.fn((): ApiKeyApplicationPort | null => null);
			const response: Response = await invoke(
				createApiKeyHttpHandlers(resolver).list,
				event({ locals: unavailableIdentityLocalsWithPrincipal() })
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:identity-unavailable'
			});
			expect(resolver).not.toHaveBeenCalled();
		});

		it('forwards a malformed cursor unchanged, leaving authorization to the store', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({ search: '?cursor=not-a-uuid' })
			);
			expect(response.status).toBe(200);
			expect(app.listApiKeys).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ cursor: 'not-a-uuid', limit: 25 }
			);
		});

		it('rejects a cursor exceeding the bounded length without inspecting its shape', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({ search: `?cursor=${'x'.repeat(201)}` })
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
			expect(app.listApiKeys).not.toHaveBeenCalled();
		});

		it('rejects an out-of-bounds limit', async () => {
			const app: ApiKeyApplicationPort = application();
			const tooLarge: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({ search: '?limit=1000' })
			);
			const zero: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({ search: '?limit=0' })
			);
			expect(tooLarge.status).toBe(400);
			expect(zero.status).toBe(400);
			expect(app.listApiKeys).not.toHaveBeenCalled();
		});

		it('rejects unknown query parameters', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({ search: '?organizationId=attacker-organization' })
			);
			expect(response.status).toBe(400);
			expect(app.listApiKeys).not.toHaveBeenCalled();
		});

		it('applies the default limit and scopes to the authenticated identity only', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({})
			);
			expect(response.status).toBe(200);
			expect(app.listApiKeys).toHaveBeenCalledWith({ id: 'user-1' }, { cursor: null, limit: 25 });
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body: { page: { items: ApiKeyMetadata[] } } = await response.json();
			expect(body.page.items).toHaveLength(1);
			expect(body.page.items[0]).not.toHaveProperty('token');
		});

		it('passes an explicit cursor and limit through', async () => {
			const app: ApiKeyApplicationPort = application();
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({ search: `?cursor=${KEY_ID}&limit=5` })
			);
			expect(response.status).toBe(200);
			expect(app.listApiKeys).toHaveBeenCalledWith({ id: 'user-1' }, { cursor: KEY_ID, limit: 5 });
		});

		it('maps owner_not_active to an RFC 9457 problem', async () => {
			const app: ApiKeyApplicationPort = application();
			(app.listApiKeys as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'owner_not_active'
			} satisfies ListApiKeyResult);
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({})
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:api-key-owner-not-active'
			});
		});

		it('maps owner_not_active to 403 even for a malformed cursor', async () => {
			const app: ApiKeyApplicationPort = application();
			(app.listApiKeys as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'owner_not_active'
			} satisfies ListApiKeyResult);
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): ApiKeyApplicationPort => app).list,
				event({ search: '?cursor=not-a-uuid' })
			);
			expect(app.listApiKeys).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ cursor: 'not-a-uuid', limit: 25 }
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:api-key-owner-not-active'
			});
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await invoke(
				createApiKeyHttpHandlers((): null => null).list,
				event({})
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});
	});
});
