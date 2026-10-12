import { beforeEach, describe, expect, it, vi } from 'vitest';
import { instanceScopedLocals } from '$lib/http/http-handler-test-support';
import type { DashboardApplicationPort } from '$lib/application/dashboard/dashboard-service';
import type { DashboardPage } from '$lib/application/dashboard/model';

const resolveDashboardApplication = vi.fn();
vi.mock('$lib/application/dashboard/dashboard-runtime', () => ({
	resolveDashboardApplication: (...args: unknown[]) => resolveDashboardApplication(...args)
}));

const { resolveDashboardWorklist } = await import('./dashboard-worklist-request');

const EMPTY_PAGE: DashboardPage = {
	items: [],
	nextCursor: null,
	counts: { all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 }
};

function fakeApplication(page: DashboardPage = EMPTY_PAGE): {
	application: DashboardApplicationPort;
	read: ReturnType<typeof vi.fn>;
} {
	const read = vi.fn().mockResolvedValue(page);
	return { application: { read }, read };
}

describe('resolveDashboardWorklist', () => {
	beforeEach(() => {
		resolveDashboardApplication.mockReset();
	});

	it('rejects an anonymous caller with 401 before touching the store', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('anonymous'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(401);
		expect(outcome.kind).toBe('authorization');
		expect(resolveDashboardApplication).not.toHaveBeenCalled();
	});

	it('rejects a non-member with 403', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('no_membership'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(403);
		expect(outcome.kind).toBe('authorization');
	});

	it('rejects a suspended member with 403', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('suspended'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(403);
		expect(outcome.kind).toBe('authorization');
	});

	it('fails closed with 503 when identity is unavailable', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('unavailable'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(503);
		expect(outcome.kind).toBe('authorization');
	});

	it('rejects an API-key-only request with 403, never falling through to a cookie session', async () => {
		const locals: App.Locals = {
			...instanceScopedLocals('active'),
			apiKeyAuthentication: {
				state: 'authenticated',
				principal: { id: 'key-1', userId: 'user-1', scopes: [] } as never
			}
		};
		const outcome = await resolveDashboardWorklist(
			locals,
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(403);
		expect(outcome.kind).toBe('authorization');
		expect(resolveDashboardApplication).not.toHaveBeenCalled();
	});

	it('returns 503 when the durable store cannot be resolved', async () => {
		resolveDashboardApplication.mockResolvedValueOnce(null);
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(503);
		expect(outcome.kind).toBe('store');
	});

	it('rejects an unknown query parameter', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('view=all&bogus=1')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(400);
		expect(outcome.kind).toBe('validation');
		expect(resolveDashboardApplication).not.toHaveBeenCalled();
	});

	it('rejects a duplicated known query parameter', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('view=all&view=drafts')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(400);
	});

	it('rejects a cursor containing characters outside the base64url alphabet at the HTTP boundary', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('cursor=not a valid cursor!')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(400);
		expect(outcome.kind).toBe('validation');
		expect(resolveDashboardApplication).not.toHaveBeenCalled();
	});

	it('rejects a limit outside the bounded range', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('limit=0')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(400);

		const tooLarge = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('limit=101')
		);
		expect(tooLarge.outcome).toBe('error');
		if (tooLarge.outcome !== 'error') throw new Error('unreachable');
		expect(tooLarge.response.status).toBe(400);
	});

	it('defaults view to all, q to empty, cursor to null, and limit to 25', async () => {
		const { application, read } = fakeApplication();
		resolveDashboardApplication.mockResolvedValueOnce(application);
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('ok');
		expect(read).toHaveBeenCalledWith(
			{ email: 'user@example.com' },
			{ view: 'all', query: '', cursor: null, limit: 25 }
		);
	});

	it('passes the normalized caller email and parsed query through to the application', async () => {
		const { application, read } = fakeApplication();
		resolveDashboardApplication.mockResolvedValueOnce(application);
		const locals: App.Locals = {
			...instanceScopedLocals('active'),
			principal: { subject: 'user-1', email: 'User@Example.com', name: 'User' }
		};
		const outcome = await resolveDashboardWorklist(
			locals,
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('view=drafts&q=foo&limit=10')
		);
		expect(outcome.outcome).toBe('ok');
		expect(read).toHaveBeenCalledWith(
			{ email: 'User@Example.com' },
			{ view: 'drafts', query: 'foo', cursor: null, limit: 10 }
		);
	});

	it('returns a retryable failure, never a fabricated empty page, when the store read throws', async () => {
		const read = vi.fn().mockRejectedValue(new Error('db unavailable'));
		resolveDashboardApplication.mockResolvedValueOnce({ read });
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams()
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(502);
		expect(outcome.kind).toBe('store');
	});

	it('authorizes before parsing the query: an anonymous caller with a malformed query still gets 401, not 400', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('anonymous'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('limit=not-a-number&bogus=1&cursor=not-a-uuid')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(401);
		expect(outcome.kind).toBe('authorization');
	});

	it('authorizes before parsing the query: a non-member with a malformed query still gets 403, not 400', async () => {
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('no_membership'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('view=not-a-real-view')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(403);
	});

	it('rejects __proto__ and constructor as query parameter keys without polluting Object.prototype', async () => {
		const protoBefore = Object.getPrototypeOf({});
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('__proto__=x&constructor=y')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(400);
		expect(outcome.kind).toBe('validation');
		expect(Object.getPrototypeOf({})).toBe(protoBefore);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('maps InvalidDashboardCursorError (malformed) from the application layer to a 400 validation failure, not 502', async () => {
		const { InvalidDashboardCursorError } =
			await import('$lib/application/dashboard/dashboard-service');
		const read = vi.fn().mockRejectedValue(new InvalidDashboardCursorError('malformed'));
		resolveDashboardApplication.mockResolvedValueOnce({ read });
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('cursor=abcDEF123-_')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(400);
		expect(outcome.kind).toBe('validation');
	});

	it('maps InvalidDashboardCursorError (context_mismatch) from the application layer to a 400 validation failure', async () => {
		const { InvalidDashboardCursorError } =
			await import('$lib/application/dashboard/dashboard-service');
		const read = vi.fn().mockRejectedValue(new InvalidDashboardCursorError('context_mismatch'));
		resolveDashboardApplication.mockResolvedValueOnce({ read });
		const outcome = await resolveDashboardWorklist(
			instanceScopedLocals('active'),
			undefined,
			'/api/v1/dashboard',
			new URLSearchParams('view=completed&cursor=abcDEF123-_')
		);
		expect(outcome.outcome).toBe('error');
		if (outcome.outcome !== 'error') throw new Error('unreachable');
		expect(outcome.response.status).toBe(400);
		expect(outcome.kind).toBe('validation');
	});
});
