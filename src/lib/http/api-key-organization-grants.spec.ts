import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	ApiKeyApplicationPort,
	GrantApiKeyOrganizationInput,
	GrantApiKeyOrganizationResult,
	ListApiKeyOrganizationGrantsResult,
	RevokeApiKeyOrganizationGrantInput,
	RevokeApiKeyOrganizationGrantResult
} from '$lib/application/api-keys/api-key-service';
import type { ApiKeyOrganizationGrantMetadata } from '$lib/ports/api-key-store';
import { createApiKeyOrganizationGrantHandlers } from './api-key-organization-grants';

const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const GRANT_ID: string = '01900000-0000-7000-8000-000000000301';
const ORG_ID: string = 'org-alpha';

const grant: ApiKeyOrganizationGrantMetadata = {
	id: GRANT_ID,
	apiKeyId: KEY_ID,
	organizationId: ORG_ID,
	grantedByUserId: 'user-1',
	grantedOrganizationRole: 'owner',
	grantedAt: '2026-09-12T12:00:00.000Z',
	revokedAt: null,
	revokedByUserId: null,
	revokedByAuthority: null
};

type OrganizationRole = 'owner' | 'admin' | 'member';

function locals(
	overrides: {
		identityState?: App.Locals['identityState'];
		role?: OrganizationRole;
		organizationId?: string | null;
		apiKeyAuthentication?: App.Locals['apiKeyAuthentication'];
		memberships?: App.Locals['memberships'];
	} = {}
): App.Locals {
	const identityState: App.Locals['identityState'] = overrides.identityState ?? 'authorized';
	const organizationId: string | null =
		overrides.organizationId === undefined ? ORG_ID : overrides.organizationId;
	return {
		apiKeyAuthentication: overrides.apiKeyAuthentication ?? { state: 'absent' },
		identityState,
		memberships:
			overrides.memberships ??
			(organizationId === null
				? []
				: [
						{
							role: overrides.role ?? 'owner',
							joinedAt: '2026-09-01T00:00:00.000Z',
							organization: {
								id: organizationId,
								slug: 'alpha',
								name: 'Alpha',
								status: 'active'
							}
						}
					]),
		organizationId,
		principal:
			identityState === 'anonymous' || identityState === 'unavailable'
				? null
				: { subject: 'user-1', email: 'user@example.com', name: 'User' }
	};
}

function event(input: {
	locals?: App.Locals;
	method?: string;
	body?: string | null;
	headers?: HeadersInit;
	search?: string;
	params?: Record<string, string>;
	pathname?: string;
}): RequestEvent {
	const pathname: string = input.pathname ?? `/api/v1/api-keys/${KEY_ID}/organization-grants`;
	const url: URL = new URL(`https://signkit.example${pathname}${input.search ?? ''}`);
	const headers: Headers = new Headers(input.headers);
	const method: string = input.method ?? 'GET';
	if (method === 'POST') {
		if (!headers.has('content-type')) headers.set('content-type', 'application/json');
		if (!headers.has('idempotency-key')) headers.set('idempotency-key', 'grant-1');
	}
	return {
		locals: input.locals ?? locals(),
		params: input.params ?? { apiKeyId: KEY_ID },
		url,
		request: new Request(url, {
			method,
			headers,
			body: method === 'POST' ? (input.body === null ? undefined : (input.body ?? '{}')) : undefined
		})
	} as RequestEvent;
}

function application(overrides: Partial<ApiKeyApplicationPort> = {}): ApiKeyApplicationPort {
	return {
		createApiKey: vi.fn(),
		listApiKeys: vi.fn(),
		revokeApiKey: vi.fn(),
		grantApiKeyOrganization: vi.fn(async (): Promise<GrantApiKeyOrganizationResult> => ({
			outcome: 'granted',
			grant
		})),
		listApiKeyOrganizationGrants: vi.fn(async (): Promise<ListApiKeyOrganizationGrantsResult> => ({
			outcome: 'listed',
			page: { items: [grant], nextCursor: null }
		})),
		revokeApiKeyOrganizationGrant: vi.fn(
			async (): Promise<RevokeApiKeyOrganizationGrantResult> => ({
				outcome: 'revoked',
				grant: {
					...grant,
					revokedAt: '2026-09-13T12:00:00.000Z',
					revokedByUserId: 'user-1',
					revokedByAuthority: 'key_owner'
				}
			})
		),
		...overrides
	};
}

function handlers(port: ApiKeyApplicationPort = application()) {
	return createApiKeyOrganizationGrantHandlers(() => port);
}

async function problemType(response: Response): Promise<string> {
	return ((await response.json()) as { type: string }).type;
}

describe('API key organization grant handlers', () => {
	describe('create', () => {
		it('grants using the session organization and the verified organization role', async () => {
			const port: ApiKeyApplicationPort = application();
			const response: Response = await handlers(port).create(
				event({ method: 'POST', locals: locals({ role: 'admin' }) })
			);

			expect(response.status).toBe(201);
			expect(await response.json()).toEqual({ grant });
			expect(port.grantApiKeyOrganization).toHaveBeenCalledWith({ id: 'user-1' }, KEY_ID, {
				idempotencyKey: 'grant-1',
				organizationId: ORG_ID,
				organizationName: 'Alpha',
				grantingOrganizationRole: 'admin'
			} satisfies GrantApiKeyOrganizationInput);
		});

		/**
		 * The organization must come solely from the verified session. A body field
		 * naming another organization has to be rejected outright rather than
		 * silently ignored, so a caller can never even appear to widen their reach.
		 */
		it('rejects a body that tries to name an organization', async () => {
			const port: ApiKeyApplicationPort = application();
			const response: Response = await handlers(port).create(
				event({ method: 'POST', body: JSON.stringify({ organizationId: 'org-victim' }) })
			);

			expect(response.status).toBe(400);
			expect(await problemType(response)).toBe('urn:signkit:problem:validation-failed');
			expect(port.grantApiKeyOrganization).not.toHaveBeenCalled();
		});

		it('requires an owner or admin role in the session organization', async () => {
			const port: ApiKeyApplicationPort = application();
			const response: Response = await handlers(port).create(
				event({ method: 'POST', locals: locals({ role: 'member' }) })
			);

			expect(response.status).toBe(403);
			expect(await problemType(response)).toBe(
				'urn:signkit:problem:api-key-organization-grant-forbidden'
			);
			expect(port.grantApiKeyOrganization).not.toHaveBeenCalled();
		});

		it('rejects an anonymous caller before touching the store', async () => {
			const port: ApiKeyApplicationPort = application();
			const response: Response = await handlers(port).create(
				event({
					method: 'POST',
					locals: locals({ identityState: 'anonymous', organizationId: null })
				})
			);

			expect(response.status).toBe(401);
			expect(port.grantApiKeyOrganization).not.toHaveBeenCalled();
		});

		it('rejects a caller with no active organization', async () => {
			const response: Response = await handlers().create(
				event({
					method: 'POST',
					locals: locals({ identityState: 'no_active_organization', organizationId: null })
				})
			);

			expect(response.status).toBe(403);
			expect(await problemType(response)).toBe('urn:signkit:problem:organization-required');
		});

		/** Granting is the one operation an API key must never reach. */
		it('rejects a presented API key bearer', async () => {
			const port: ApiKeyApplicationPort = application();
			const response: Response = await handlers(port).create(
				event({
					method: 'POST',
					locals: locals({ apiKeyAuthentication: { state: 'invalid_token' } })
				})
			);

			expect(response.status).toBe(403);
			expect(await problemType(response)).toBe('urn:signkit:problem:api-key-not-permitted');
			expect(port.grantApiKeyOrganization).not.toHaveBeenCalled();
		});

		it('requires a bounded Idempotency-Key', async () => {
			const response: Response = await handlers().create(
				event({ method: 'POST', headers: { 'idempotency-key': '' } })
			);
			expect(response.status).toBe(400);
			expect(await problemType(response)).toBe('urn:signkit:problem:idempotency-key-required');
		});

		it('requires an application/json body', async () => {
			const response: Response = await handlers().create(
				event({ method: 'POST', headers: { 'content-type': 'text/plain' } })
			);
			expect(response.status).toBe(415);
		});

		it('bounds the request body', async () => {
			const response: Response = await handlers().create(
				event({ method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(2048) }) })
			);
			expect(response.status).toBe(413);
		});

		it('rejects invalid JSON', async () => {
			const response: Response = await handlers().create(event({ method: 'POST', body: '{' }));
			expect(response.status).toBe(400);
			expect(await problemType(response)).toBe('urn:signkit:problem:invalid-json');
		});

		it('labels only a genuine exact-key replay as an idempotent replay', async () => {
			const replayed: Response = await handlers(
				application({
					grantApiKeyOrganization: vi.fn(async (): Promise<GrantApiKeyOrganizationResult> => ({
						outcome: 'replayed',
						grant
					}))
				})
			).create(event({ method: 'POST' }));
			expect(replayed.status).toBe(200);
			expect(replayed.headers.get('idempotency-replayed')).toBe('true');

			const alreadyGranted: Response = await handlers(
				application({
					grantApiKeyOrganization: vi.fn(async (): Promise<GrantApiKeyOrganizationResult> => ({
						outcome: 'already_granted',
						grant
					}))
				})
			).create(event({ method: 'POST' }));
			expect(alreadyGranted.status).toBe(200);
			expect(alreadyGranted.headers.get('idempotency-replayed')).toBeNull();
		});

		it.each([
			['idempotency_conflict', 409, 'urn:signkit:problem:api-key-grant-idempotency-conflict'],
			['not_found', 404, 'urn:signkit:problem:api-key-organization-grant-not-found'],
			['key_not_active', 409, 'urn:signkit:problem:api-key-not-active'],
			['owner_not_active', 403, 'urn:signkit:problem:api-key-owner-not-active'],
			['integrity_error', 503, 'urn:signkit:problem:api-key-grant-integrity-error']
		] as const)('maps %s to %i', async (outcome, status, type) => {
			const response: Response = await handlers(
				application({
					grantApiKeyOrganization: vi.fn(
						async (): Promise<GrantApiKeyOrganizationResult> =>
							({ outcome }) as GrantApiKeyOrganizationResult
					)
				})
			).create(event({ method: 'POST' }));

			expect(response.status).toBe(status);
			expect(await problemType(response)).toBe(type);
		});

		it('never echoes token or hash material', async () => {
			const response: Response = await handlers().create(event({ method: 'POST' }));
			const body: string = await response.text();
			expect(body).not.toContain('signkit_');
			expect(body).not.toMatch(/[0-9a-f]{64}/);
		});
	});

	describe('list', () => {
		it('returns the owner grant page', async () => {
			const port: ApiKeyApplicationPort = application();
			const response: Response = await handlers(port).list(event({}));

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ page: { items: [grant], nextCursor: null } });
			expect(port.listApiKeyOrganizationGrants).toHaveBeenCalledWith({ id: 'user-1' }, KEY_ID, {
				cursor: null,
				limit: 25
			});
		});

		/** Identity is enough: listing must not require organization authority. */
		it('authorizes a caller with no active organization', async () => {
			const response: Response = await handlers().list(
				event({ locals: locals({ identityState: 'no_active_organization', organizationId: null }) })
			);
			expect(response.status).toBe(200);
		});

		it('rejects an anonymous caller', async () => {
			const response: Response = await handlers().list(
				event({ locals: locals({ identityState: 'anonymous', organizationId: null }) })
			);
			expect(response.status).toBe(401);
		});

		it('rejects a presented API key bearer', async () => {
			const response: Response = await handlers().list(
				event({
					locals: locals({
						apiKeyAuthentication: {
							state: 'authenticated',
							principal: {
								apiKeyId: KEY_ID,
								keyPrefix: 'signkit_abcdefgh',
								ownerUserId: 'user-1',
								organizationId: ORG_ID,
								organizationName: 'Alpha',
								scopes: ['envelopes:read'],
								expiresAt: '2026-12-11T00:00:00.000Z'
							}
						}
					})
				})
			);
			expect(response.status).toBe(403);
			expect(await problemType(response)).toBe('urn:signkit:problem:api-key-not-permitted');
		});

		it('forwards a malformed cursor unvalidated so the store fails it closed', async () => {
			const port: ApiKeyApplicationPort = application();
			await handlers(port).list(event({ search: '?cursor=not-a-uuid' }));
			expect(port.listApiKeyOrganizationGrants).toHaveBeenCalledWith({ id: 'user-1' }, KEY_ID, {
				cursor: 'not-a-uuid',
				limit: 25
			});
		});

		it('bounds the page size', async () => {
			const response: Response = await handlers().list(event({ search: '?limit=500' }));
			expect(response.status).toBe(400);
		});

		it.each([
			['not_found', 404, 'urn:signkit:problem:api-key-organization-grant-not-found'],
			['owner_not_active', 403, 'urn:signkit:problem:api-key-owner-not-active']
		] as const)('maps %s to %i', async (outcome, status, type) => {
			const response: Response = await handlers(
				application({
					listApiKeyOrganizationGrants: vi.fn(
						async (): Promise<ListApiKeyOrganizationGrantsResult> =>
							({ outcome }) as ListApiKeyOrganizationGrantsResult
					)
				})
			).list(event({}));

			expect(response.status).toBe(status);
			expect(await problemType(response)).toBe(type);
		});
	});

	describe('revoke', () => {
		const revokePath: string = `/api/v1/api-keys/${KEY_ID}/organization-grants/${GRANT_ID}/revoke`;
		const revokeParams: Record<string, string> = { apiKeyId: KEY_ID, grantId: GRANT_ID };

		function revokeEvent(overrides: Parameters<typeof event>[0] = {}): RequestEvent {
			return event({
				method: 'POST',
				pathname: revokePath,
				params: revokeParams,
				headers: { 'idempotency-key': 'revoke-1' },
				...overrides
			});
		}

		it('claims owner scope and the session organization scope for an admin', async () => {
			const port: ApiKeyApplicationPort = application();
			const response: Response = await handlers(port).revoke(revokeEvent());

			expect(response.status).toBe(200);
			expect(port.revokeApiKeyOrganizationGrant).toHaveBeenCalledWith(
				{ id: 'user-1' },
				KEY_ID,
				GRANT_ID,
				{
					idempotencyKey: 'revoke-1',
					ownerScope: true,
					organizationScope: ORG_ID
				} satisfies RevokeApiKeyOrganizationGrantInput
			);
		});

		/**
		 * A key owner who holds no d6e organization membership must still be able to
		 * de-scope their own agent, so revocation carries owner scope with no
		 * organization scope at all.
		 */
		it('claims owner scope only for a caller with no active organization', async () => {
			const port: ApiKeyApplicationPort = application();
			await handlers(port).revoke(
				revokeEvent({
					locals: locals({ identityState: 'no_active_organization', organizationId: null })
				})
			);

			expect(port.revokeApiKeyOrganizationGrant).toHaveBeenCalledWith(
				{ id: 'user-1' },
				KEY_ID,
				GRANT_ID,
				{ idempotencyKey: 'revoke-1', ownerScope: true, organizationScope: null }
			);
		});

		/**
		 * An organization `member` has no administration authority, so they must not
		 * receive organization scope -- otherwise any member of any organization could
		 * revoke grants for it.
		 */
		it('withholds organization scope from a mere organization member', async () => {
			const port: ApiKeyApplicationPort = application();
			await handlers(port).revoke(revokeEvent({ locals: locals({ role: 'member' }) }));

			expect(port.revokeApiKeyOrganizationGrant).toHaveBeenCalledWith(
				{ id: 'user-1' },
				KEY_ID,
				GRANT_ID,
				{ idempotencyKey: 'revoke-1', ownerScope: true, organizationScope: null }
			);
		});

		it('never lets a request field choose the organization scope', async () => {
			const port: ApiKeyApplicationPort = application();
			// A body naming another organization is rejected outright by the strict
			// empty-object schema, so it can never reach the store as a scope.
			const response: Response = await handlers(port).revoke(
				revokeEvent({ body: JSON.stringify({ organizationScope: 'org-victim' }) })
			);
			expect(response.status).toBe(400);
			expect(port.revokeApiKeyOrganizationGrant).not.toHaveBeenCalled();
		});

		it('rejects an anonymous caller', async () => {
			const response: Response = await handlers().revoke(
				revokeEvent({
					locals: locals({ identityState: 'anonymous', organizationId: null })
				})
			);
			expect(response.status).toBe(401);
		});

		it('rejects a presented API key bearer', async () => {
			const response: Response = await handlers().revoke(
				revokeEvent({
					locals: locals({ apiKeyAuthentication: { state: 'invalid_token' } })
				})
			);
			expect(response.status).toBe(403);
			expect(await problemType(response)).toBe('urn:signkit:problem:api-key-not-permitted');
		});

		it('labels only an exact-key replay as an idempotent replay', async () => {
			const replayed: Response = await handlers(
				application({
					revokeApiKeyOrganizationGrant: vi.fn(
						async (): Promise<RevokeApiKeyOrganizationGrantResult> => ({
							outcome: 'replayed',
							grant
						})
					)
				})
			).revoke(revokeEvent());
			expect(replayed.status).toBe(200);
			expect(replayed.headers.get('idempotency-replayed')).toBe('true');

			const already: Response = await handlers(
				application({
					revokeApiKeyOrganizationGrant: vi.fn(
						async (): Promise<RevokeApiKeyOrganizationGrantResult> => ({
							outcome: 'already_revoked',
							grant
						})
					)
				})
			).revoke(revokeEvent());
			expect(already.status).toBe(200);
			expect(already.headers.get('idempotency-replayed')).toBeNull();
		});

		it.each([
			['idempotency_conflict', 409, 'urn:signkit:problem:api-key-grant-idempotency-conflict'],
			['not_found', 404, 'urn:signkit:problem:api-key-organization-grant-not-found'],
			['owner_not_active', 403, 'urn:signkit:problem:api-key-owner-not-active'],
			['integrity_error', 503, 'urn:signkit:problem:api-key-grant-integrity-error']
		] as const)('maps %s to %i', async (outcome, status, type) => {
			const response: Response = await handlers(
				application({
					revokeApiKeyOrganizationGrant: vi.fn(
						async (): Promise<RevokeApiKeyOrganizationGrantResult> =>
							({ outcome }) as RevokeApiKeyOrganizationGrantResult
					)
				})
			).revoke(revokeEvent());

			expect(response.status).toBe(status);
			expect(await problemType(response)).toBe(type);
		});
	});

	it('reports an unconfigured durable store as unavailable', async () => {
		const unconfigured = createApiKeyOrganizationGrantHandlers(() => null);
		const response: Response = await unconfigured.list(event({}));
		expect(response.status).toBe(503);
		expect(await problemType(response)).toBe('urn:signkit:problem:persistence-unavailable');
	});
});
