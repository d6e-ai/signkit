import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import type { InstanceMemberMetadata } from '$lib/ports/instance-store';
import { createInstanceMemberMeHandler } from './instance-members';

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
