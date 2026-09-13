import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import {
	InvalidInstanceMemberRequestError,
	type InstanceMemberApplicationPort,
	type ListInstanceMembersResult,
	type SetInstanceMemberRoleResult,
	type SetInstanceMemberStatusResult
} from '$lib/application/instance-members/instance-member-service';
import type { InstanceMemberMetadata } from '$lib/ports/instance-store';
import {
	createInstanceMemberHttpHandlers,
	createInstanceMemberMeHandler,
	type InstanceMemberApplicationResolver
} from './instance-members';

const NOW: string = '2026-09-12T12:00:00.000Z';

const mockMember: InstanceMemberMetadata = {
	userId: 'user-1',
	role: 'owner',
	status: 'active',
	createdAt: NOW,
	updatedAt: NOW
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

function event(input: { locals?: App.Locals } = {}): RequestEvent {
	const pathname: string = '/api/v1/instance/members/me';
	const url: URL = new URL(`https://signkit.example${pathname}`);
	return {
		locals: input.locals ?? locals(),
		params: {},
		request: new Request(url, { method: 'GET' }),
		url
	} as RequestEvent;
}

describe('GET /api/v1/instance/members/me HTTP handler', () => {
	it('requires identity only and fails closed for anonymous caller', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceMemberMeHandler((): InstanceApplicationPort => app);

		const res = await handler(event({ locals: locals('anonymous') }));
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:authentication-required',
			status: 401
		});
		expect(app.getCurrentMember).not.toHaveBeenCalled();
	});

	it('fails closed when identity is unavailable', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceMemberMeHandler((): InstanceApplicationPort => app);

		const res = await handler(event({ locals: locals('unavailable') }));
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:identity-unavailable',
			status: 503
		});
		expect(app.getCurrentMember).not.toHaveBeenCalled();
	});

	it('returns null member and bootstrapped false when instance is unbootstrapped', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn().mockResolvedValue({
				member: null,
				bootstrapped: false
			})
		};
		const handler = createInstanceMemberMeHandler((): InstanceApplicationPort => app);

		const res = await handler(event());
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({
			member: null,
			bootstrapped: false
		});
		expect(app.getCurrentMember).toHaveBeenCalledWith({ id: 'user-1' });
	});

	it('returns member metadata and bootstrapped true when caller is an active member', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn().mockResolvedValue({
				member: mockMember,
				bootstrapped: true
			})
		};
		const handler = createInstanceMemberMeHandler((): InstanceApplicationPort => app);

		const res = await handler(event());
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({
			member: mockMember,
			bootstrapped: true
		});
	});

	it('returns null member and bootstrapped true when caller is a non-member on a bootstrapped instance', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn().mockResolvedValue({
				member: null,
				bootstrapped: true
			})
		};
		const handler = createInstanceMemberMeHandler((): InstanceApplicationPort => app);

		const res = await handler(event());
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({
			member: null,
			bootstrapped: true
		});
	});

	it('returns 503 problem when persistence is unavailable', async () => {
		const handler = createInstanceMemberMeHandler((): InstanceApplicationPort | null => null);

		const res = await handler(event());
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:persistence-unavailable',
			status: 503
		});
	});
});

const TARGET_USER_ID: string = 'target-user-1';

const targetMember: InstanceMemberMetadata = {
	userId: TARGET_USER_ID,
	role: 'member',
	status: 'active',
	createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: NOW
};

function memberEvent(input: {
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

function memberApplication(): InstanceMemberApplicationPort {
	const list = vi.fn(async (): Promise<ListInstanceMembersResult> => ({
		outcome: 'listed',
		page: { items: [targetMember], nextCursor: null }
	}));
	const setRole = vi.fn(async (): Promise<SetInstanceMemberRoleResult> => ({
		outcome: 'updated',
		member: { ...targetMember, role: 'admin' },
		appliedAt: NOW,
		revokedInvitationCount: 0
	}));
	const setStatus = vi.fn(async (): Promise<SetInstanceMemberStatusResult> => ({
		outcome: 'updated',
		member: { ...targetMember, status: 'suspended' },
		appliedAt: NOW,
		revokedInvitationCount: 0
	}));
	return {
		list,
		listInstanceMembers: list,
		setRole,
		setInstanceMemberRole: setRole,
		setStatus,
		setInstanceMemberStatus: setStatus
	};
}

const LIST_PATH: string = '/api/v1/instance/members';
const rolePath = (userId: string): string => `/api/v1/instance/members/${userId}/role`;
const statusPath = (userId: string): string => `/api/v1/instance/members/${userId}/status`;

describe('instance member administration HTTP handlers', () => {
	describe('list', () => {
		it('rejects anonymous callers before resolving dependencies', async () => {
			const resolver: InstanceMemberApplicationResolver = vi.fn(
				(): InstanceMemberApplicationPort | null => null
			);
			const response: Response = await createInstanceMemberHttpHandlers(resolver).list(
				memberEvent({ pathname: LIST_PATH, locals: locals('anonymous') })
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('fails closed with 503 when identity verification is unavailable', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).list(memberEvent({ pathname: LIST_PATH, locals: locals('unavailable') }));
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:identity-unavailable'
			});
		});

		it('does not require an active organization', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).list(memberEvent({ pathname: LIST_PATH, locals: locals('no_active_organization') }));
			expect(response.status).toBe(200);
		});

		it('rejects an out-of-bounds limit', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).list(memberEvent({ pathname: LIST_PATH, search: '?limit=0' }));
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('applies the default limit and scopes to the authenticated identity only', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).list(memberEvent({ pathname: LIST_PATH }));
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(app.list).toHaveBeenCalledWith({ id: 'user-1' }, { cursor: null, limit: 25 });
			expect(await response.json()).toEqual({
				members: [targetMember],
				nextCursor: null
			});
		});

		it('passes an explicit cursor and limit through', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			await createInstanceMemberHttpHandlers((): InstanceMemberApplicationPort => app).list(
				memberEvent({ pathname: LIST_PATH, search: '?cursor=abc&limit=10' })
			);
			expect(app.list).toHaveBeenCalledWith({ id: 'user-1' }, { cursor: 'abc', limit: 10 });
		});

		it.each([
			['forbidden', 403, 'urn:signkit:problem:instance-member-forbidden'],
			['member_suspended', 403, 'urn:signkit:problem:instance-member-suspended']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: InstanceMemberApplicationPort = memberApplication();
			(app.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ outcome });
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).list(memberEvent({ pathname: LIST_PATH }));
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ type, status });
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort | null => null
			).list(memberEvent({ pathname: LIST_PATH }));
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});
	});

	describe('setRole', () => {
		it('rejects anonymous callers before parsing or resolving dependencies', async () => {
			const resolver: InstanceMemberApplicationResolver = vi.fn(
				(): InstanceMemberApplicationPort | null => null
			);
			const response: Response = await createInstanceMemberHttpHandlers(resolver).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					locals: locals('anonymous')
				})
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('requires a bounded visible-ASCII Idempotency-Key', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:idempotency-key-required'
			});
		});

		it('requires application/json content type', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1', 'content-type': 'text/plain' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(response.status).toBe(415);
		});

		it('rejects request bodies larger than the bounded 1 KiB limit', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin', padding: 'x'.repeat(2000) })
				})
			);
			expect(response.status).toBe(413);
		});

		it('rejects invalid JSON', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: '{not json'
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:invalid-json' });
		});

		it('rejects a role outside the fixed enum', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'superadmin' })
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('scopes the mutation to the authenticated identity and path target user', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			await createInstanceMemberHttpHandlers((): InstanceMemberApplicationPort => app).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(app.setRole).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ idempotencyKey: 'role-1', targetUserId: TARGET_USER_ID, role: 'admin' }
			);
		});

		it('returns updated member metadata, appliedAt, and revokedInvitationCount without a replay header', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('idempotency-replayed')).toBeNull();
			expect(await response.json()).toEqual({
				member: { ...targetMember, role: 'admin' },
				appliedAt: NOW,
				revokedInvitationCount: 0
			});
		});

		it('marks an exact replay with the idempotency-replayed header', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			(app.setRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'replayed',
				member: { ...targetMember, role: 'admin' },
				appliedAt: '2026-09-01T08:00:00.000Z',
				revokedInvitationCount: 2
			} satisfies SetInstanceMemberRoleResult);
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBe('true');
			const responseBody: { appliedAt: string; revokedInvitationCount: number } =
				await response.json();
			expect(responseBody.appliedAt).toBe('2026-09-01T08:00:00.000Z');
			expect(responseBody.revokedInvitationCount).toBe(2);
		});

		it.each([
			['forbidden', 403, 'urn:signkit:problem:instance-member-forbidden'],
			['member_suspended', 403, 'urn:signkit:problem:instance-member-suspended'],
			['role_not_permitted', 403, 'urn:signkit:problem:instance-member-role-not-permitted'],
			['member_not_found', 404, 'urn:signkit:problem:instance-member-not-found'],
			['last_active_owner', 409, 'urn:signkit:problem:instance-member-last-active-owner'],
			['idempotency_conflict', 409, 'urn:signkit:problem:instance-member-idempotency-conflict'],
			['integrity_error', 503, 'urn:signkit:problem:instance-member-integrity-error']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: InstanceMemberApplicationPort = memberApplication();
			(app.setRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome
			} satisfies SetInstanceMemberRoleResult);
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ type, status });
		});

		it('translates an invalid normalized request into a validation problem', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			(app.setRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new InvalidInstanceMemberRequestError('Invalid target user identifier.')
			);
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort | null => null
			).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});

		it('never logs a resolver error message, which may embed credentials or request content', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			await createInstanceMemberHttpHandlers(async () => {
				throw new Error('db connection string leaked here');
			}).setRole(
				memberEvent({
					pathname: rolePath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'role-1' },
					body: JSON.stringify({ role: 'admin' })
				})
			);
			for (const call of consoleErrorSpy.mock.calls) {
				expect(JSON.stringify(call)).not.toContain('db connection string leaked here');
			}
			consoleErrorSpy.mockRestore();
		});
	});

	describe('setStatus', () => {
		it('rejects anonymous callers before parsing or resolving dependencies', async () => {
			const resolver: InstanceMemberApplicationResolver = vi.fn(
				(): InstanceMemberApplicationPort | null => null
			);
			const response: Response = await createInstanceMemberHttpHandlers(resolver).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					locals: locals('anonymous')
				})
			);
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
		});

		it('requires a bounded visible-ASCII Idempotency-Key', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					body: JSON.stringify({ status: 'suspended' })
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:idempotency-key-required'
			});
		});

		it('rejects a status outside the fixed enum', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => memberApplication()
			).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'status-1' },
					body: JSON.stringify({ status: 'dormant' })
				})
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:validation-failed'
			});
		});

		it('scopes the mutation to the authenticated identity and path target user', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			await createInstanceMemberHttpHandlers((): InstanceMemberApplicationPort => app).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'status-1' },
					body: JSON.stringify({ status: 'suspended' })
				})
			);
			expect(app.setStatus).toHaveBeenCalledWith(
				{ id: 'user-1' },
				{ idempotencyKey: 'status-1', targetUserId: TARGET_USER_ID, status: 'suspended' }
			);
		});

		it('returns updated member metadata, appliedAt, and revokedInvitationCount without a replay header', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'status-1' },
					body: JSON.stringify({ status: 'suspended' })
				})
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBeNull();
			expect(await response.json()).toEqual({
				member: { ...targetMember, status: 'suspended' },
				appliedAt: NOW,
				revokedInvitationCount: 0
			});
		});

		it('marks an exact replay with the idempotency-replayed header', async () => {
			const app: InstanceMemberApplicationPort = memberApplication();
			(app.setStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome: 'replayed',
				member: { ...targetMember, status: 'suspended' },
				appliedAt: '2026-09-01T08:00:00.000Z',
				revokedInvitationCount: 1
			} satisfies SetInstanceMemberStatusResult);
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'status-1' },
					body: JSON.stringify({ status: 'suspended' })
				})
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBe('true');
		});

		it.each([
			['forbidden', 403, 'urn:signkit:problem:instance-member-forbidden'],
			['member_suspended', 403, 'urn:signkit:problem:instance-member-suspended'],
			['member_not_found', 404, 'urn:signkit:problem:instance-member-not-found'],
			['last_active_owner', 409, 'urn:signkit:problem:instance-member-last-active-owner'],
			['cannot_target_self', 409, 'urn:signkit:problem:instance-member-cannot-target-self'],
			['idempotency_conflict', 409, 'urn:signkit:problem:instance-member-idempotency-conflict'],
			['integrity_error', 503, 'urn:signkit:problem:instance-member-integrity-error']
		] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
			const app: InstanceMemberApplicationPort = memberApplication();
			(app.setStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				outcome
			} satisfies SetInstanceMemberStatusResult);
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort => app
			).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'status-1' },
					body: JSON.stringify({ status: 'suspended' })
				})
			);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ type, status });
		});

		it('fails closed with 503 when persistence is not wired', async () => {
			const response: Response = await createInstanceMemberHttpHandlers(
				(): InstanceMemberApplicationPort | null => null
			).setStatus(
				memberEvent({
					pathname: statusPath(TARGET_USER_ID),
					method: 'POST',
					params: { userId: TARGET_USER_ID },
					headers: { 'idempotency-key': 'status-1' },
					body: JSON.stringify({ status: 'suspended' })
				})
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				type: 'urn:signkit:problem:persistence-unavailable'
			});
		});
	});
});
