import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardPage, DashboardQuery } from '$lib/application/dashboard/model';
import type { DashboardWorklistOutcome } from '$lib/server/dashboard-worklist-request';

const resolveDashboardWorklist = vi.fn<(...args: unknown[]) => Promise<DashboardWorklistOutcome>>();
vi.mock('$lib/server/dashboard-worklist-request', () => ({
	resolveDashboardWorklist: (...args: unknown[]) => resolveDashboardWorklist(...args)
}));

const { load } = await import('./+page.server');

function stripLocalePrefix(pathname: string): string {
	return pathname.replace(/^\/(en|ja)(?=\/|$)/, '') || '/';
}

async function captureRedirect(result: unknown): Promise<{ status: number; location: string }> {
	try {
		await result;
	} catch (error: unknown) {
		if (isRedirect(error))
			return { status: error.status, location: stripLocalePrefix(error.location) };
		throw error;
	}
	throw new Error('expected a redirect to be thrown');
}

async function captureHttpError(result: unknown): Promise<{ status: number }> {
	try {
		await result;
	} catch (error: unknown) {
		if (isHttpError(error)) return { status: error.status };
		throw error;
	}
	throw new Error('expected an http error to be thrown');
}

const QUERY: DashboardQuery = { view: 'all', query: '', cursor: null, limit: 25 };

function problemResponse(status: number, type: string, detail: string): Response {
	return new Response(JSON.stringify({ type, title: detail, status, detail, instance: '/' }), {
		status,
		headers: { 'content-type': 'application/problem+json' }
	});
}

function event(input: {
	setHeaders?: (headers: Record<string, string>) => void;
	parent?: () => Promise<unknown>;
}): Parameters<typeof load>[0] {
	const url: URL = new URL('https://signkit.example/');
	return {
		locals: {} as App.Locals,
		params: {},
		platform: undefined,
		url,
		parent: input.parent ?? (async () => ({})),
		setHeaders: input.setHeaders ?? (() => undefined)
	} as unknown as Parameters<typeof load>[0];
}

describe('root +page.server.ts worklist loader', () => {
	let headers: Record<string, string>;

	beforeEach(() => {
		resolveDashboardWorklist.mockReset();
		headers = {};
	});

	it('awaits the layout gate before reading the worklist, so its redirect wins deterministically', async () => {
		let parentCalled: boolean = false;
		let worklistCalledAfterParent: boolean = false;
		resolveDashboardWorklist.mockImplementation(async () => {
			worklistCalledAfterParent = parentCalled;
			return { outcome: 'ok', query: QUERY, page: emptyPage() } satisfies DashboardWorklistOutcome;
		});
		await load(
			event({
				parent: async () => {
					parentCalled = true;
					return {};
				}
			})
		);
		expect(worklistCalledAfterParent).toBe(true);
	});

	it('sets a private, no-store cache-control header', async () => {
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'ok',
			query: QUERY,
			page: emptyPage()
		} satisfies DashboardWorklistOutcome);
		await load(event({ setHeaders: (value) => Object.assign(headers, value) }));
		expect(headers['cache-control']).toBe('private, no-store');
	});

	it('returns the worklist page with a null worklistError on success', async () => {
		const page: DashboardPage = {
			items: [],
			nextCursor: null,
			counts: { all: 3, actionRequired: 1, waiting: 1, drafts: 1, completed: 0 }
		};
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'ok',
			query: QUERY,
			page
		} satisfies DashboardWorklistOutcome);
		const result = await load(event({}));
		expect(result).toEqual({ worklist: page, worklistQuery: QUERY, worklistError: null });
	});

	it('redirects an anonymous (401) authorization failure to /auth/login, never a successful page with worklistError', async () => {
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'error',
			query: QUERY,
			kind: 'authorization',
			response: problemResponse(
				401,
				'urn:signkit:problem:authentication-required',
				'Sign in required.'
			)
		} satisfies DashboardWorklistOutcome);
		const redirected = await captureRedirect(load(event({})));
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe('/auth/login?return=%2F');
	});

	it('redirects a non-member/suspended (403) authorization failure to /settings, never a successful page with worklistError', async () => {
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'error',
			query: QUERY,
			kind: 'authorization',
			response: problemResponse(
				403,
				'urn:signkit:problem:instance-membership-required',
				'Membership required.'
			)
		} satisfies DashboardWorklistOutcome);
		const redirected = await captureRedirect(load(event({})));
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe('/settings');
	});

	it('fails closed with a 503 http error when identity is unavailable, never a successful page with worklistError', async () => {
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'error',
			query: QUERY,
			kind: 'authorization',
			response: problemResponse(
				503,
				'urn:signkit:problem:identity-unavailable',
				'Identity unavailable.'
			)
		} satisfies DashboardWorklistOutcome);
		const failed = await captureHttpError(load(event({})));
		expect(failed.status).toBe(503);
	});

	it('fails closed with a 400 http error for a validation failure, never a successful page with worklistError', async () => {
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'error',
			query: QUERY,
			kind: 'validation',
			response: problemResponse(400, 'urn:signkit:problem:validation', 'Bad query.')
		} satisfies DashboardWorklistOutcome);
		const failed = await captureHttpError(load(event({})));
		expect(failed.status).toBe(400);
	});

	it('renders a retryable worklistError with worklist: null only for a genuine storage failure, never swallowing authorization', async () => {
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'error',
			query: QUERY,
			kind: 'store',
			response: problemResponse(503, 'urn:signkit:problem:persistence-unavailable', 'Store down.')
		} satisfies DashboardWorklistOutcome);
		const result = await load(event({}));
		expect(result).toEqual({
			worklist: null,
			worklistQuery: QUERY,
			worklistError: { status: 503, message: 'Store down.' }
		});
	});

	it('derives authority from locals via the shared helper, not from the parent load result', async () => {
		resolveDashboardWorklist.mockResolvedValue({
			outcome: 'ok',
			query: QUERY,
			page: emptyPage()
		} satisfies DashboardWorklistOutcome);
		// A parent load that claims a privileged role must not influence the
		// worklist read: `resolveDashboardWorklist` is called with `locals`
		// only, never with the parent's resolved data.
		await load(event({ parent: async () => ({ instanceMemberRole: 'owner' }) }));
		expect(resolveDashboardWorklist).toHaveBeenCalledWith(
			expect.anything(),
			undefined,
			'/',
			expect.anything()
		);
	});
});

function emptyPage(): DashboardPage {
	return {
		items: [],
		nextCursor: null,
		counts: { all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 }
	};
}
