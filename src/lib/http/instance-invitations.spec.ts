import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const captureMemberDisplay = vi.hoisted(() => ({
	bestEffortCaptureMemberDisplay: vi.fn(async (): Promise<null> => {
		throw new Error('ciphertext exploded for user@example.com');
	})
}));
vi.mock('$lib/server/instance-display-capture', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/instance-display-capture')>()),
	...captureMemberDisplay
}));
import {
	InstanceInvitationCollisionExhaustedError,
	InvalidInstanceInvitationRequestError,
	type AcceptInstanceInvitationResult,
	type CreateInstanceInvitationResult,
	type InstanceInvitationApplicationPort,
	type ListInstanceInvitationsResult,
	type ListReceivedInstanceInvitationsResult,
	type RevokeInstanceInvitationResult
} from '$lib/application/instance-invitations/instance-invitation-service';
import type { InstanceInvitationMetadata, InstanceMemberMetadata } from '$lib/ports/instance-store';
import {
	CONSOLE_NOTE_DELIVERY_HOLD_MS,
	type ConsoleInvitationNoteOutcome,
	type ConsoleInvitationNotesPort
} from '$lib/server/console-invitation-notes';
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
		invitation
	}));
	const list = vi.fn(async (): Promise<ListInstanceInvitationsResult> => ({
		outcome: 'listed',
		page: { items: [invitation], nextCursor: null }
	}));
	const revoke = vi.fn(async (): Promise<RevokeInstanceInvitationResult> => ({
		outcome: 'revoked',
		invitation
	}));
	const listReceived = vi.fn(async (): Promise<ListReceivedInstanceInvitationsResult> => ({
		outcome: 'listed',
		items: [
			{
				id: INVITATION_ID,
				role: 'member',
				createdAt: invitation.createdAt,
				expiresAt: invitation.expiresAt
			}
		]
	}));
	const acceptReceived = vi.fn(async (): Promise<AcceptInstanceInvitationResult> => ({
		outcome: 'accepted',
		invitation,
		member
	}));
	return {
		create,
		createInstanceInvitation: create,
		list,
		listInstanceInvitations: list,
		listReceived,
		acceptReceived,
		revoke,
		revokeInstanceInvitation: revoke,
		settleDelivery: vi.fn(async () => ({ outcome: 'released' as const }))
	};
}

async function invoke(
	handler: (requestEvent: RequestEvent) => Response | Promise<Response>,
	requestEvent: RequestEvent
): Promise<Response> {
	return handler(requestEvent);
}

const CREATE_PATH: string = '/api/v1/instance/invitations';
const revokePath = (id: string): string => `/api/v1/instance/invitations/${id}/revoke`;
const RECEIVED_PATH: string = '/api/v1/instance/invitations/received';
const acceptReceivedPath = (id: string): string => `/api/v1/instance/invitations/${id}/accept`;

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
				{
					idempotencyKey: 'create-1',
					email: 'invitee@example.com',
					role: 'member',
					locale: undefined,
					deliveryHoldMs: CONSOLE_NOTE_DELIVERY_HOLD_MS
				}
			);
			const body: { invitation: InstanceInvitationMetadata; delivery: { status: string } } =
				await response.json();
			expect(body.delivery).toEqual({ status: 'scheduled' });
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
			expect(body).not.toHaveProperty('invitationDisplays');
		});

		it('attaches invitationDisplays after authorization when enrichment is wired', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const display = {
				captureMemberSnapshot: vi.fn(),
				memberDisplays: vi.fn(),
				invitationDisplays: vi.fn(async () => ({
					[INVITATION_ID]: { state: 'pending' as const, email: 'invitee@example.com' }
				}))
			};
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(
					(): InstanceInvitationApplicationPort => app,
					(): typeof display => display
				).list,
				event({ pathname: CREATE_PATH })
			);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toMatchObject({
				invitations: [invitation],
				nextCursor: null,
				invitationDisplays: {
					[INVITATION_ID]: { state: 'pending', email: 'invitee@example.com' }
				}
			});
		});

		it('keeps invitation metadata usable when display enrichment fails', async () => {
			const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers(
					(): InstanceInvitationApplicationPort => application(),
					(): never => {
						throw new Error('ciphertext exploded for invitee@example.com');
					}
				).list,
				event({ pathname: CREATE_PATH })
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				invitations: [invitation],
				nextCursor: null,
				invitationDisplays: { [INVITATION_ID]: { state: 'unavailable' } }
			});
			expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('invitee@example.com');
			errorSpy.mockRestore();
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

		it('forwards view=active with the default history query otherwise unchanged', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: `?view=active&cursor=${INVITATION_ID}` })
			);
			expect(response.status).toBe(200);
			expect(app.list).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ cursor: INVITATION_ID, limit: 25, view: 'active' }
			);
		});

		it('rejects an unknown list view without calling the application', async () => {
			const app: InstanceInvitationApplicationPort = application();
			const response: Response = await invoke(
				createInstanceInvitationHttpHandlers((): InstanceInvitationApplicationPort => app).list,
				event({ pathname: CREATE_PATH, search: '?view=history' })
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
			expect(app.list).not.toHaveBeenCalled();
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

	describe('console invitation notes', () => {
		function notes(outcome: ConsoleInvitationNoteOutcome = 'sent'): ConsoleInvitationNotesPort & {
			note: ReturnType<typeof vi.fn>;
			forget: ReturnType<typeof vi.fn>;
		} {
			return {
				note: vi.fn(async (): Promise<ConsoleInvitationNoteOutcome> => outcome),
				forget: vi.fn(async (): Promise<ConsoleInvitationNoteOutcome> => 'sent')
			};
		}

		function createEvent(): RequestEvent {
			return event({
				pathname: CREATE_PATH,
				method: 'POST',
				body: validCreateBody({ email: '  Invitee@Example.COM ' }),
				headers: { 'idempotency-key': 'create-1' }
			});
		}

		it('notes a created invitation with the normalized email, expiry, and inviter', async () => {
			const app = application();
			const port = notes();
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app, null, port).create,
				createEvent()
			);
			expect(response.status).toBe(201);
			expect(port.note).toHaveBeenCalledWith(
				{
					invitationId: INVITATION_ID,
					recipientEmail: 'invitee@example.com',
					expiresAt: invitation.expiresAt,
					inviterSubject: 'user-1',
					locale: 'ja'
				},
				expect.objectContaining({})
			);
		});

		it('names the invitation locale in the note', async () => {
			const app = application();
			const port = notes();
			await invoke(
				createInstanceInvitationHttpHandlers(() => app, null, port).create,
				event({
					pathname: CREATE_PATH,
					method: 'POST',
					body: validCreateBody({ locale: 'en' }),
					headers: { 'idempotency-key': 'create-en' }
				})
			);
			expect(port.note).toHaveBeenCalledWith(
				expect.objectContaining({ locale: 'en' }),
				expect.objectContaining({})
			);
		});

		it('holds the outbox row and closes it once D6E Auth holds the note', async () => {
			for (const outcome of ['sent', 'withdrawn'] as const) {
				const app = application();
				const response = await invoke(
					createInstanceInvitationHttpHandlers(() => app, null, notes(outcome)).create,
					createEvent()
				);
				expect(response.status).toBe(201);
				expect(app.create).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({ deliveryHoldMs: CONSOLE_NOTE_DELIVERY_HOLD_MS })
				);
				expect(app.settleDelivery).toHaveBeenCalledWith(INVITATION_ID, 'console');
			}
		});

		it('releases the outbox row for the drain when the note did not get through', async () => {
			for (const outcome of ['failed', 'disabled'] as const) {
				const app = application();
				await invoke(
					createInstanceInvitationHttpHandlers(() => app, null, notes(outcome)).create,
					createEvent()
				);
				expect(app.settleDelivery).toHaveBeenCalledWith(INVITATION_ID, 'self');
			}

			const thrownApp = application();
			const thrownPort = notes();
			thrownPort.note.mockRejectedValueOnce(new Error('D6E Auth down'));
			await invoke(
				createInstanceInvitationHttpHandlers(() => thrownApp, null, thrownPort).create,
				createEvent()
			);
			expect(thrownApp.settleDelivery).toHaveBeenCalledWith(INVITATION_ID, 'self');
		});

		it('keeps the create response when settling the own mail fails', async () => {
			const app = application();
			(app.settleDelivery as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new Error('database down')
			);
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			try {
				const response = await invoke(
					createInstanceInvitationHttpHandlers(() => app, null, notes()).create,
					createEvent()
				);
				expect(response.status).toBe(201);
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					expect.stringContaining('instance_invitation_delivery_settle_failed')
				);
			} finally {
				consoleErrorSpy.mockRestore();
			}
		});

		it('re-notes an exact replay of a pending invitation but not of a finished one', async () => {
			const pendingApp = application();
			(pendingApp.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'replayed',
				invitation,
				replayed: true
			} satisfies CreateInstanceInvitationResult);
			const pendingPort = notes();
			await invoke(
				createInstanceInvitationHttpHandlers(() => pendingApp, null, pendingPort).create,
				createEvent()
			);
			expect(pendingPort.note).toHaveBeenCalledTimes(1);

			const revokedApp = application();
			(revokedApp.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'replayed',
				invitation: { ...invitation, status: 'revoked', revokedAt: invitation.createdAt },
				replayed: true
			} satisfies CreateInstanceInvitationResult);
			const revokedPort = notes();
			await invoke(
				createInstanceInvitationHttpHandlers(() => revokedApp, null, revokedPort).create,
				createEvent()
			);
			expect(revokedPort.note).not.toHaveBeenCalled();
		});

		it('does not note a refused create', async () => {
			const app = application();
			(app.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'forbidden'
			} satisfies CreateInstanceInvitationResult);
			const port = notes();
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app, null, port).create,
				createEvent()
			);
			expect(response.status).toBe(403);
			expect(port.note).not.toHaveBeenCalled();
		});

		it('waits for the note before answering a create on Workers, so a revoke cannot overtake it', async () => {
			const app = application();
			const port = notes();
			let noted: boolean = false;
			port.note.mockImplementationOnce(async (): Promise<ConsoleInvitationNoteOutcome> => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				noted = true;
				return 'sent';
			});
			const waitUntil = vi.fn();
			const requestEvent: RequestEvent = createEvent();
			(requestEvent as { platform?: unknown }).platform = { context: { waitUntil } };
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app, null, port).create,
				requestEvent
			);
			expect(response.status).toBe(201);
			expect(noted).toBe(true);
			expect(waitUntil).not.toHaveBeenCalled();
		});

		it('lets the withdrawal continue after the revoke response on Workers', async () => {
			const app = application();
			const port = notes();
			const waitUntil = vi.fn();
			const requestEvent: RequestEvent = event({
				pathname: revokePath(INVITATION_ID),
				method: 'POST',
				body: '{}',
				headers: { 'idempotency-key': 'revoke-1' },
				params: { invitationId: INVITATION_ID }
			});
			(requestEvent as { platform?: unknown }).platform = { context: { waitUntil } };
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app, null, port).revoke,
				requestEvent
			);
			expect(response.status).toBe(200);
			expect(waitUntil).toHaveBeenCalledTimes(1);
			expect(port.forget).toHaveBeenCalledWith(INVITATION_ID, expect.objectContaining({}));
		});

		it('keeps the create response when the note fails', async () => {
			const app = application();
			const port = notes();
			port.note.mockRejectedValueOnce(new Error('D6E Auth down'));
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app, null, port).create,
				createEvent()
			);
			expect(response.status).toBe(201);
		});

		it('withdraws the note after a revoke, including an exact replay', async () => {
			for (const result of [
				{ outcome: 'revoked', invitation },
				{ outcome: 'replayed', invitation, replayed: true }
			] satisfies RevokeInstanceInvitationResult[]) {
				const app = application();
				(app.revoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(result);
				const port = notes();
				const response = await invoke(
					createInstanceInvitationHttpHandlers(() => app, null, port).revoke,
					event({
						pathname: revokePath(INVITATION_ID),
						method: 'POST',
						body: '{}',
						headers: { 'idempotency-key': 'revoke-1' },
						params: { invitationId: INVITATION_ID }
					})
				);
				expect(response.status).toBe(200);
				expect(port.forget).toHaveBeenCalledWith(INVITATION_ID, expect.objectContaining({}));
			}
		});

		it('never touches notes when accepting', async () => {
			const app = application();
			const port = notes();
			await invoke(
				createInstanceInvitationHttpHandlers(() => app, null, port).acceptReceived,
				event({
					pathname: acceptReceivedPath(INVITATION_ID),
					method: 'POST',
					body: '{}',
					headers: { 'idempotency-key': 'accept-2' },
					params: { invitationId: INVITATION_ID },
					locals: locals('no_membership')
				})
			);
			expect(port.note).not.toHaveBeenCalled();
			expect(port.forget).not.toHaveBeenCalled();
		});
	});

	describe('listReceived', () => {
		it('rejects anonymous callers before resolving dependencies', async () => {
			const resolver = vi.fn(() => application());
			const response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).listReceived,
				event({ pathname: RECEIVED_PATH, locals: locals('anonymous') })
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('requires a provider-verified email claim before matching anything', async () => {
			const resolver = vi.fn(() => application());
			const response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).listReceived,
				event({
					pathname: RECEIVED_PATH,
					locals: identityOnlyLocals('no_membership', { emailVerified: false })
				})
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:email-verification-required'
			});
			expect(resolver).not.toHaveBeenCalled();
		});

		it('rejects query parameters, so no request value can select another email', async () => {
			const app = application();
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app).listReceived,
				event({ pathname: RECEIVED_PATH, search: '?email=other%40example.com' })
			);
			expect(response.status).toBe(400);
			expect(app.listReceived).not.toHaveBeenCalled();
		});

		it("lists by the caller's own verified email and names the account it was matched for", async () => {
			const app = application();
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app).listReceived,
				event({ pathname: RECEIVED_PATH, locals: locals('no_membership') })
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(app.listReceived).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ email: 'user@example.com' }
			);
			expect(await response.json()).toEqual({
				account: { subject: 'user-1', email: 'user@example.com' },
				invitations: [
					{
						id: INVITATION_ID,
						role: 'member',
						createdAt: invitation.createdAt,
						expiresAt: invitation.expiresAt
					}
				]
			});
		});

		it('returns an empty list to active and suspended members alike', async () => {
			for (const result of [
				{ outcome: 'already_member', member },
				{ outcome: 'member_suspended' }
			] satisfies ListReceivedInstanceInvitationsResult[]) {
				const app = application();
				(app.listReceived as ReturnType<typeof vi.fn>).mockResolvedValueOnce(result);
				const response = await invoke(
					createInstanceInvitationHttpHandlers(() => app).listReceived,
					event({ pathname: RECEIVED_PATH })
				);
				expect(response.status).toBe(200);
				const body: { invitations: unknown[] } = await response.json();
				expect(body.invitations).toEqual([]);
			}
		});

		it('rejects an API key, never composing it with a cookie session', async () => {
			const resolver = vi.fn(() => application());
			const response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).listReceived,
				event({
					pathname: RECEIVED_PATH,
					locals: {
						...locals('active'),
						apiKeyAuthentication: { state: 'rejected_surface' }
					} as App.Locals
				})
			);
			expect(response.status).toBe(403);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => null).listReceived,
				event({ pathname: RECEIVED_PATH })
			);
			expect(response.status).toBe(503);
		});
	});

	describe('acceptReceived', () => {
		function acceptReceivedEvent(
			overrides: Partial<Parameters<typeof event>[0]> = {}
		): RequestEvent {
			return event({
				pathname: acceptReceivedPath(INVITATION_ID),
				method: 'POST',
				body: '{}',
				headers: { 'idempotency-key': 'accept-received-1' },
				params: { invitationId: INVITATION_ID },
				locals: locals('no_membership'),
				...overrides
			});
		}

		it('rejects a stale displayed account before resolving or consuming an invitation', async () => {
			const resolver = vi.fn(() => application());
			const response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).acceptReceived,
				acceptReceivedEvent({
					headers: {
						'idempotency-key': 'accept-received-1',
						'x-signkit-expected-subject': 'previous-user'
					}
				})
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:account-changed' });
			expect(resolver).not.toHaveBeenCalled();
		});

		it('rejects anonymous callers before resolving dependencies', async () => {
			const resolver = vi.fn(() => application());
			const response = await invoke(
				createInstanceInvitationHttpHandlers(resolver).acceptReceived,
				acceptReceivedEvent({ locals: locals('anonymous') })
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('requires an Idempotency-Key', async () => {
			const app = application();
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app).acceptReceived,
				acceptReceivedEvent({ headers: {} })
			);
			expect(response.status).toBe(400);
			expect(app.acceptReceived).not.toHaveBeenCalled();
		});

		it('rejects a body-supplied email or token: the body must be empty', async () => {
			for (const body of [
				JSON.stringify({ email: 'other@example.com' }),
				JSON.stringify({ token: VALID_TOKEN })
			]) {
				const app = application();
				const response = await invoke(
					createInstanceInvitationHttpHandlers(() => app).acceptReceived,
					acceptReceivedEvent({ body })
				);
				expect(response.status).toBe(400);
				expect(app.acceptReceived).not.toHaveBeenCalled();
			}
		});

		it('requires a provider-verified email claim', async () => {
			const app = application();
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app).acceptReceived,
				acceptReceivedEvent({
					locals: identityOnlyLocals('no_membership', { emailVerified: false })
				})
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:email-verification-required'
			});
			expect(app.acceptReceived).not.toHaveBeenCalled();
		});

		it("accepts the path invitation with the caller's own verified email", async () => {
			const app = application();
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app).acceptReceived,
				acceptReceivedEvent({
					headers: {
						'idempotency-key': 'accept-received-1',
						'x-signkit-expected-subject': 'user-1'
					}
				})
			);
			expect(response.status).toBe(200);
			expect(app.acceptReceived).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{
					idempotencyKey: 'accept-received-1',
					invitationId: INVITATION_ID,
					email: 'user@example.com'
				}
			);
			expect(await response.json()).toMatchObject({
				invitation: { id: INVITATION_ID },
				member: { userId: member.userId }
			});
			expect(captureMemberDisplay.bestEffortCaptureMemberDisplay).toHaveBeenCalledWith(
				expect.objectContaining({ memberUserId: member.userId })
			);
		});

		it('shares the link accept responses: replay header, opaque 404, and already-member 409', async () => {
			const cases: [AcceptInstanceInvitationResult, number][] = [
				[{ outcome: 'replayed', invitation, member, replayed: true }, 200],
				[{ outcome: 'invitation_invalid' }, 404],
				[{ outcome: 'member_suspended' }, 404],
				[{ outcome: 'already_member', member }, 409],
				[{ outcome: 'idempotency_conflict' }, 409]
			];
			const bodies: Record<string, unknown> = {};
			for (const [result, status] of cases) {
				const app = application();
				(app.acceptReceived as ReturnType<typeof vi.fn>).mockResolvedValueOnce(result);
				const response = await invoke(
					createInstanceInvitationHttpHandlers(() => app).acceptReceived,
					acceptReceivedEvent()
				);
				expect(response.status).toBe(status);
				if (result.outcome === 'replayed') {
					expect(response.headers.get('idempotency-replayed')).toBe('true');
				}
				bodies[result.outcome] = await response.json();
			}
			expect(bodies.invitation_invalid).toEqual(bodies.member_suspended);
			expect(bodies.already_member).toMatchObject({
				type: 'urn:signkit:problem:instance-member-already-exists'
			});
		});

		it('routes a malformed invitation id to validation-failed', async () => {
			const app = application();
			(app.acceptReceived as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new InvalidInstanceInvitationRequestError('Invalid instance invitation identifier.')
			);
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => app).acceptReceived,
				acceptReceivedEvent({
					pathname: acceptReceivedPath('not-a-uuid'),
					params: { invitationId: 'not-a-uuid' }
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response = await invoke(
				createInstanceInvitationHttpHandlers(() => null).acceptReceived,
				acceptReceivedEvent()
			);
			expect(response.status).toBe(503);
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
