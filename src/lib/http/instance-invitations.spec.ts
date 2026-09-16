import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	InstanceInvitationCollisionExhaustedError,
	InvalidInstanceInvitationRequestError,
	type AcceptInstanceInvitationResult,
	type CreateInstanceInvitationResult,
	type InstanceInvitationApplicationPort,
	type ListInstanceInvitationsResult,
	type RevokeInstanceInvitationResult
} from '$lib/application/instance-invitations/instance-invitation-service';
import type { InstanceInvitationMetadata, InstanceMemberMetadata } from '$lib/ports/instance-store';
import {
	identityOnlyLocals,
	unavailableIdentityLocalsWithPrincipal
} from './http-handler-test-support';
import {
	createInstanceInvitationHttpHandlers,
	type InstanceInvitationApplicationResolver
} from './instance-invitations';

const INVITATION_ID: string = '01900000-0000-7000-8000-000000000201';
const VALID_TOKEN: string = `ski1_${'A'.repeat(43)}`;

const invitation: InstanceInvitationMetadata = {
	id: INVITATION_ID,
	role: 'member',
	status: 'pending',
	invitedByUserId: 'user-1',
	createdAt: '2026-09-12T00:00:00.000Z',
	expiresAt: '2026-09-19T00:00:00.000Z',
	acceptedAt: null,
	acceptedByUserId: null,
	revokedAt: null,
	revokedByUserId: null
};

const member: InstanceMemberMetadata = {
	userId: 'user-2',
	role: 'member',
	status: 'active',
	createdAt: '2026-09-13T00:00:00.000Z',
	updatedAt: '2026-09-13T00:00:00.000Z'
};

/** This surface additionally requires a verified email, unlike other identity-only surfaces. */
function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return identityOnlyLocals(state, { emailVerified: true });
}

function event(input: {
	pathname: string;
	locals?: App.Locals;
	method?: string;
	body?: string;
	headers?: HeadersInit;
	search?: string;
	params?: Record<string, string>;
}): RequestEvent {
	const url: URL = new URL(`https://signkit.example${input.pathname}${input.search ?? ''}`);
	const headers: Headers = new Headers(input.headers);
	if (input.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	return {
		locals: input.locals ?? locals(),
		params: input.params ?? {},
		request: new Request(url, { method: input.method ?? 'GET', headers, body: input.body }),
		url
	} as RequestEvent;
}

function application(): InstanceInvitationApplicationPort {
	const create = vi.fn(async (): Promise<CreateInstanceInvitationResult> => ({
		outcome: 'created',
		invitation,
		token: VALID_TOKEN
	}));
	const list = vi.fn(async (): Promise<ListInstanceInvitationsResult> => ({
		outcome: 'listed',
		page: { items: [invitation], nextCursor: null }
	}));
	const accept = vi.fn(async (): Promise<AcceptInstanceInvitationResult> => ({
		outcome: 'accepted',
		invitation,
		member
	}));
	const revoke = vi.fn(async (): Promise<RevokeInstanceInvitationResult> => ({
		outcome: 'revoked',
		invitation
	}));
	return {
		create,
		createInstanceInvitation: create,
		list,
		listInstanceInvitations: list,
		accept,
		acceptInstanceInvitation: accept,
		revoke,
		revokeInstanceInvitation: revoke
	};
}

async function invoke(
	handler: (requestEvent: RequestEvent) => Response | Promise<Response>,
	requestEvent: RequestEvent
): Promise<Response> {
	return handler(requestEvent);
}

const CREATE_PATH: string = '/api/v1/instance/invitations';
const ACCEPT_PATH: string = '/api/v1/instance/invitations/accept';
const revokePath = (id: string): string => `/api/v1/instance/invitations/${id}/revoke`;

function validCreateBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ email: 'invitee@example.com', role: 'member', ...overrides });
}

describe('instance invitation HTTP handlers', () => {
	describe('create', () => {
		it('rejects anonymous callers before parsing or resolving dependencies', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).create,
				event({
					pathname: CREATE_PATH,
					locals: locals('anonymous'),
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:authentication-required'
			});
			expect(resolver).not.toHaveBeenCalled();
		});

		it('rejects an anonymous caller even with a malformed body', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).create,
				event({
					pathname: CREATE_PATH,
					locals: locals('anonymous'),
					method: 'POST',
					body: '{not json',
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when identity verification is unavailable', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).create,
				event({
					pathname: CREATE_PATH,
					locals: locals('unavailable'),
					method: 'POST',
					body: validCreateBody(),
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
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).create,
				event({
					pathname: CREATE_PATH,
					locals: unavailableIdentityLocalsWithPrincipal(),
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('does not require an active organization', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					locals: locals('no_membership'),
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(201);
		});

		it('requires a bounded visible-ASCII Idempotency-Key', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const handler = createInstanceInvitationHttpHandlers(
				(): InstanceInvitationApplicationPort => app
			).create;
			const missing: Response = await invoke(
				handler,
				event({ pathname: CREATE_PATH, method: 'POST', body: validCreateBody() })
			);
			const spaced: Response = await invoke(
				handler,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'has space' }
				})
			);
			const long: Response = await invoke(
				handler,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'x'.repeat(201) }
				})
			);
			expect(missing.status).toBe(400);
			expect(spaced.status).toBe(400);
			expect(long.status).toBe(400);
			expect(app.create).not.toHaveBeenCalled();
		});

		it('requires application/json content type', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'content-type': 'text/plain', 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(415);
			expect(app.create).not.toHaveBeenCalled();
		});

		it('rejects request bodies larger than the bounded JSON limit', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody({ email: `x@${'y'.repeat(5 * 1024)}.com` }),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(413);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:request-body-too-large'
			});
			expect(app.create).not.toHaveBeenCalled();
		});

		it('rejects invalid JSON', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: '{',
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:invalid-json' });
		});

		it('rejects unknown fields, including a caller-supplied expiry', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody({ expiresAt: '2026-12-01T00:00:00.000Z' }),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
			expect(app.create).not.toHaveBeenCalled();
		});

		it('rejects a role outside the fixed enum', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody({ role: 'superuser' }),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(app.create).not.toHaveBeenCalled();
		});

		it('translates an invalid normalized request into a validation problem', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new InvalidInstanceInvitationRequestError('Invalid instance invitation email')
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('maps exhausted credential collision retries to a 503 problem', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new InstanceInvitationCollisionExhaustedError()
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(503);
		});

		it('scopes create to the authenticated identity only, without an organization', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(201);
			expect(app.create).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ idempotencyKey: 'create-1', email: 'invitee@example.com', role: 'member' }
			);
			const body: { invitation: InstanceInvitationMetadata; token: string } = await response.json();
			expect(body.token).toBe(VALID_TOKEN);
			expect(body.invitation.id).toBe(INVITATION_ID);
			expect(response.headers.get('cache-control')).toBe('no-store');
		});

		it('returns only metadata, without the one-time token, on an exact replay', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'replayed',
				invitation,
				replayed: true
			} satisfies CreateInstanceInvitationResult);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBe('true');
			const body: Record<string, unknown> = await response.json();
			expect(body).not.toHaveProperty('token');
		});

		it.each([
			['forbidden', 403, 'urn:signkit:problem:instance-invitation-forbidden'],
			['role_not_permitted', 403, 'urn:signkit:problem:instance-invitation-role-not-permitted'],
			['limit', 409, 'urn:signkit:problem:instance-invitation-limit'],
			['idempotency_conflict', 409, 'urn:signkit:problem:instance-invitation-idempotency-conflict'],
			['member_suspended', 403, 'urn:signkit:problem:instance-invitation-member-suspended'],
			['integrity_error', 503, 'urn:signkit:problem:instance-invitation-integrity-error']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: InstanceInvitationApplicationPort = application();
			(app.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome
			} satisfies CreateInstanceInvitationResult);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(status);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toMatchObject({ type, status });
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): null => null).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody(),
					headers: { 'idempotency-key': 'create-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});
	});

	describe('list', () => {
		it('rejects anonymous callers before resolving dependencies', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).list,
				event({ pathname: CREATE_PATH, locals: locals('anonymous') })
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('rejects an anonymous caller even with a malformed cursor', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).list,
				event({
					pathname: CREATE_PATH,
					locals: locals('anonymous'),
					search: `?cursor=${'x'.repeat(500)}`
				})
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when identity verification is unavailable', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).list,
				event({ pathname: CREATE_PATH, locals: locals('unavailable') })
			);
			expect(response.status).toBe(503);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when unavailable even if a principal is present', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).list,
				event({ pathname: CREATE_PATH, locals: unavailableIdentityLocalsWithPrincipal() })
			);
			expect(response.status).toBe(503);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('does not require an active organization', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, locals: locals('no_membership') })
			);
			expect(response.status).toBe(200);
		});

		it('forwards a malformed cursor unchanged, leaving authorization to the store', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: '?cursor=not-a-uuid' })
			);
			expect(response.status).toBe(200);
			expect(app.list).toHaveBeenCalledWith({ id: 'user-1' }, { cursor: 'not-a-uuid', limit: 25 });
		});

		it('rejects a cursor exceeding the bounded length without inspecting its shape', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: `?cursor=${'x'.repeat(201)}` })
			);
			expect(response.status).toBe(400);
			expect(app.list).not.toHaveBeenCalled();
		});

		it('rejects an out-of-bounds limit', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const tooLarge: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: '?limit=1000' })
			);
			const zero: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: '?limit=0' })
			);
			expect(tooLarge.status).toBe(400);
			expect(zero.status).toBe(400);
			expect(app.list).not.toHaveBeenCalled();
		});

		it('rejects unknown query parameters, including an organization scope', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: '?organizationId=attacker-organization' })
			);
			expect(response.status).toBe(400);
			expect(app.list).not.toHaveBeenCalled();
		});

		it('applies the default limit and scopes to the authenticated identity only', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH })
			);
			expect(response.status).toBe(200);
			expect(app.list).toHaveBeenCalledWith({ id: 'user-1' }, { cursor: null, limit: 25 });
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body: { invitations: InstanceInvitationMetadata[]; nextCursor: string | null } =
				await response.json();
			expect(body.invitations).toHaveLength(1);
			expect(body.nextCursor).toBeNull();
		});

		it('returns only safe, zero-PII invitation fields', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH })
			);
			const body: { invitations: Record<string, unknown>[] } = await response.json();
			for (const item of body.invitations) {
				expect(item).not.toHaveProperty('token');
				expect(item).not.toHaveProperty('tokenHash');
				expect(item).not.toHaveProperty('emailBinding');
				expect(item).not.toHaveProperty('email');
			}
		});

		it('passes an explicit cursor and limit through', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: `?cursor=${INVITATION_ID}&limit=5` })
			);
			expect(response.status).toBe(200);
			expect(app.list).toHaveBeenCalledWith({ id: 'user-1' }, { cursor: INVITATION_ID, limit: 5 });
		});

		it.each([
			['forbidden', 403, 'urn:signkit:problem:instance-invitation-forbidden'],
			['member_suspended', 403, 'urn:signkit:problem:instance-invitation-member-suspended']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: InstanceInvitationApplicationPort = application();
			(app.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome
			} satisfies ListInstanceInvitationsResult);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH })
			);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ type, status });
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): null => null).list,
				event({ pathname: CREATE_PATH })
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});
	});

	describe('accept', () => {
		function validAcceptBody(overrides: Record<string, unknown> = {}): string {
			return JSON.stringify({ token: VALID_TOKEN, ...overrides });
		}

		it('rejects anonymous callers before parsing or resolving dependencies', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).accept,
				event({
					pathname: ACCEPT_PATH,
					locals: locals('anonymous'),
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('rejects an anonymous caller even with a malformed body', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).accept,
				event({
					pathname: ACCEPT_PATH,
					locals: locals('anonymous'),
					method: 'POST',
					body: '{not json',
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when identity verification is unavailable', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).accept,
				event({
					pathname: ACCEPT_PATH,
					locals: locals('unavailable'),
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when unavailable even if a principal is present', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).accept,
				event({
					pathname: ACCEPT_PATH,
					locals: unavailableIdentityLocalsWithPrincipal(),
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('does not require an active organization', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					locals: locals('no_membership'),
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(200);
		});

		it('requires a bounded visible-ASCII Idempotency-Key', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const handler = createInstanceInvitationHttpHandlers(
				(): InstanceInvitationApplicationPort => app
			).accept;
			const missing: Response = await invoke(
				handler,
				event({ pathname: ACCEPT_PATH, method: 'POST', body: validAcceptBody() })
			);
			expect(missing.status).toBe(400);
			expect(app.accept).not.toHaveBeenCalled();
		});

		it('requires application/json content type', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'content-type': 'text/plain', 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(415);
			expect(app.accept).not.toHaveBeenCalled();
		});

		it('rejects request bodies larger than the bounded JSON limit', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody({ padding: 'x'.repeat(5 * 1024) }),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(413);
			expect(app.accept).not.toHaveBeenCalled();
		});

		it('rejects invalid JSON', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: '{',
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(400);
		});

		it('rejects a token that does not match the ski1_ shape', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody({ token: 'not-a-real-token' }),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(app.accept).not.toHaveBeenCalled();
		});

		it('rejects a caller-supplied email: only the token is accepted', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody({ email: 'attacker@example.com' }),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
			expect(app.accept).not.toHaveBeenCalled();
		});

		it.each([
			['missing', undefined],
			['false', false]
		] as const)(
			'fails closed when the authenticated emailVerified claim is %s',
			async (_name, emailVerified) => {
				const app: InstanceInvitationApplicationPort = application();
				const principal = {
					subject: 'user-1',
					email: 'user@example.com',
					name: 'User',
					...(emailVerified === undefined ? {} : { emailVerified })
				};
				const response: Response = await invoke(
					createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
					event({
						pathname: ACCEPT_PATH,
						locals: {
							apiKeyAuthentication: { state: 'absent' },
							bootstrapped: true,
							identityState: 'active',
							instanceMembership: {
								userId: principal.subject,
								role: 'member',
								status: 'active'
							},
							principal
						},
						method: 'POST',
						body: validAcceptBody(),
						headers: { 'idempotency-key': 'accept-1' }
					})
				);
				expect(response.status).toBe(403);
				expect(await response.json()).toMatchObject({
					type: 'urn:signkit:problem:email-verification-required',
					status: 403
				});
				expect(app.accept).not.toHaveBeenCalled();
			}
		);

		it("uses the authenticated identity's own email, never a body-supplied value", async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(200);
			expect(app.accept).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ idempotencyKey: 'accept-1', token: VALID_TOKEN, email: 'user@example.com' }
			);
		});

		it('returns the invitation and member on a fresh accept, without a replay header', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('idempotency-replayed')).toBeNull();
			const body: { invitation: InstanceInvitationMetadata; member: InstanceMemberMetadata } =
				await response.json();
			expect(body.invitation.id).toBe(INVITATION_ID);
			expect(body.member.userId).toBe(member.userId);
		});

		it('marks an exact replay with the idempotency-replayed header', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.accept as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'replayed',
				invitation,
				member,
				replayed: true
			} satisfies AcceptInstanceInvitationResult);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBe('true');
		});

		it('maps invitation_invalid and member_suspended to the identical opaque 404', async () => {
			const invalidApp: InstanceInvitationApplicationPort = application();
			(invalidApp.accept as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'invitation_invalid'
			} satisfies AcceptInstanceInvitationResult);
			const suspendedApp: InstanceInvitationApplicationPort = application();
			(suspendedApp.accept as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'member_suspended'
			} satisfies AcceptInstanceInvitationResult);

			const requestEvent = (): RequestEvent =>
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				});

			const invalidResponse: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => invalidApp)
					.accept,
				requestEvent()
			);
			const suspendedResponse: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => suspendedApp)
					.accept,
				requestEvent()
			);

			expect(invalidResponse.status).toBe(404);
			expect(suspendedResponse.status).toBe(404);
			expect(await invalidResponse.json()).toEqual(await suspendedResponse.json());
		});

		it('maps already_member to an RFC 9457 409 problem with caller member metadata and no invitation, token, hash, or email', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.accept as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'already_member',
				member
			} satisfies AcceptInstanceInvitationResult);

			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);

			expect(response.status).toBe(409);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body: Record<string, unknown> = await response.json();
			expect(body).toEqual({
				type: 'urn:signkit:problem:instance-member-already-exists',
				title: 'Instance member already exists',
				status: 409,
				detail: 'The authenticated caller is already an active instance member.',
				instance: ACCEPT_PATH,
				member
			});
			expect(body).not.toHaveProperty('invitation');
			expect(body).not.toHaveProperty('token');
			expect(body).not.toHaveProperty('hash');
			expect(body).not.toHaveProperty('email');
		});

		it.each([
			['idempotency_conflict', 409, 'urn:signkit:problem:instance-invitation-idempotency-conflict'],
			['integrity_error', 503, 'urn:signkit:problem:instance-invitation-integrity-error']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: InstanceInvitationApplicationPort = application();
			(app.accept as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome
			} satisfies AcceptInstanceInvitationResult);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ type, status });
		});

		it('translates an invalid normalized request into a validation problem', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.accept as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new InvalidInstanceInvitationRequestError('Invalid instance invitation token')
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(400);
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): null => null).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});

		it('returns 503 when application resolution throws', async () => {
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(async () => {
					throw new Error('db unavailable');
				}).accept,
				event({
					pathname: ACCEPT_PATH,
					method: 'POST',
					body: validAcceptBody(),
					headers: { 'idempotency-key': 'accept-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});

		it('never logs a resolver error message, which may embed credentials or request content', async () => {
			const SENTINEL_SECRET: string = 'sentinel-secret-do-not-log-Xk4pQz9';
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const response: Response = await invoke(
					createInstanceInvitationHttpHandlers(async () => {
						throw new Error(`connection failed: password=${SENTINEL_SECRET}`);
					}).accept,
					event({
						pathname: ACCEPT_PATH,
						method: 'POST',
						body: validAcceptBody(),
						headers: { 'idempotency-key': 'accept-1' }
					})
				);
				expect(response.status).toBe(503);
				for (const call of consoleErrorSpy.mock.calls) {
					for (const arg of call) {
						expect(String(arg)).not.toContain(SENTINEL_SECRET);
					}
				}
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					JSON.stringify({
						event: 'instance_invitation_accept_resolution_failed',
						message: 'Error'
					})
				);
			} finally {
				consoleErrorSpy.mockRestore();
			}
		});
	});

	describe('revoke', () => {
		function revokeEvent(input: {
			locals?: App.Locals;
			body?: string;
			headers?: HeadersInit;
			invitationId?: string;
		}): RequestEvent {
			const id: string = input.invitationId ?? INVITATION_ID;
			return event({
				pathname: revokePath(id),
				locals: input.locals,
				method: 'POST',
				body: input.body ?? '{}',
				headers: input.headers,
				params: { invitationId: id }
			});
		}

		it('rejects anonymous callers before parsing or resolving dependencies', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).revoke,
				revokeEvent({ locals: locals('anonymous'), headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('rejects an anonymous caller even with a malformed invitation id', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).revoke,
				revokeEvent({
					locals: locals('anonymous'),
					invitationId: 'not-a-uuid',
					headers: { 'idempotency-key': 'revoke-1' }
				})
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when identity verification is unavailable', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).revoke,
				revokeEvent({ locals: locals('unavailable'), headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(503);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when unavailable even if a principal is present', async () => {
			const resolver: InstanceInvitationApplicationResolver = vi.fn(
				(): InstanceInvitationApplicationPort | null => null
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).revoke,
				revokeEvent({
					locals: unavailableIdentityLocalsWithPrincipal(),
					headers: { 'idempotency-key': 'revoke-1' }
				})
			);
			expect(response.status).toBe(503);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('does not require an active organization', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({
					locals: locals('no_membership'),
					headers: { 'idempotency-key': 'revoke-1' }
				})
			);
			expect(response.status).toBe(200);
		});

		it('requires a bounded visible-ASCII Idempotency-Key', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const handler = createInstanceInvitationHttpHandlers(
				(): InstanceInvitationApplicationPort => app
			).revoke;
			const missing: Response = await invoke(handler, revokeEvent({}));
			const spaced: Response = await invoke(
				handler,
				revokeEvent({ headers: { 'idempotency-key': 'has space' } })
			);
			expect(missing.status).toBe(400);
			expect(spaced.status).toBe(400);
			expect(app.revoke).not.toHaveBeenCalled();
		});

		it('requires application/json content type', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({
					headers: { 'content-type': 'text/plain', 'idempotency-key': 'revoke-1' }
				})
			);
			expect(response.status).toBe(415);
			expect(app.revoke).not.toHaveBeenCalled();
		});

		it('rejects a nonempty body', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({
					body: JSON.stringify({ reason: 'no longer needed' }),
					headers: { 'idempotency-key': 'revoke-1' }
				})
			);
			expect(response.status).toBe(400);
			expect(app.revoke).not.toHaveBeenCalled();
		});

		it('rejects oversized bodies', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({
					body: JSON.stringify({ pad: 'x'.repeat(2048) }),
					headers: { 'idempotency-key': 'revoke-1' }
				})
			);
			expect(response.status).toBe(413);
			expect(app.revoke).not.toHaveBeenCalled();
		});

		it('rejects invalid JSON', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({ body: '{', headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(400);
		});

		it('scopes revoke to the authenticated identity and path invitation id', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({ headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(200);
			expect(app.revoke).toHaveBeenCalledWith({ id: 'user-1' }, INVITATION_ID, {
				idempotencyKey: 'revoke-1'
			});
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body: { invitation: InstanceInvitationMetadata } = await response.json();
			expect(body.invitation.id).toBe(INVITATION_ID);
		});

		it('marks an exact replay with the idempotency-replayed header', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.revoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'replayed',
				invitation,
				replayed: true
			} satisfies RevokeInstanceInvitationResult);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({ headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBe('true');
		});

		it('returns 200 without the replay header for a fresh revoke', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({ headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.headers.get('idempotency-replayed')).toBeNull();
		});

		it.each([
			['forbidden', 403, 'urn:signkit:problem:instance-invitation-forbidden'],
			['member_suspended', 403, 'urn:signkit:problem:instance-invitation-member-suspended'],
			['invitation_invalid', 404, 'urn:signkit:problem:instance-invitation-not-found'],
			['idempotency_conflict', 409, 'urn:signkit:problem:instance-invitation-idempotency-conflict'],
			['integrity_error', 503, 'urn:signkit:problem:instance-invitation-integrity-error']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: InstanceInvitationApplicationPort = application();
			(app.revoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome
			} satisfies RevokeInstanceInvitationResult);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({ headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(status);
			const body: Record<string, unknown> = await response.json();
			expect(body).toMatchObject({ type, status });
			// The `instance` field is the caller's own request path and may echo
			// back the id they submitted; only the invitation's role must never
			// appear, since that would leak state the caller has not proven.
			expect(body).not.toHaveProperty('role');
			expect(JSON.stringify(body)).not.toContain('"role"');
		});

		it('routes a malformed invitation id to validation-failed, matching the identifier convention', async () => {
			const app: InstanceInvitationApplicationPort = application();
			(app.revoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new InvalidInstanceInvitationRequestError('Invalid instance invitation identifier.')
			);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).revoke,
				revokeEvent({ invitationId: 'not-a-uuid', headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): null => null).revoke,
				revokeEvent({ headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});

		it('returns 503 when application resolution throws', async () => {
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(async () => {
					throw new Error('db unavailable');
				}).revoke,
				revokeEvent({ headers: { 'idempotency-key': 'revoke-1' } })
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});
	});
});
