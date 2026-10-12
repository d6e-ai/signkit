import { describe, expect, it, vi } from 'vitest';
import { createDashboardClient, DashboardApiError } from './dashboard';
import type { DashboardPage } from './dashboard';

const page: DashboardPage = {
	items: [],
	nextCursor: 'next',
	counts: { all: 1, actionRequired: 1, waiting: 0, drafts: 0, completed: 0 }
};

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('DashboardClient', () => {
	it('requests the worklist with same-origin credentials and no params by default', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(page));
		const client = createDashboardClient({ fetch: fetchMock });

		await expect(client.worklist()).resolves.toEqual(page);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/v1/dashboard',
			expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
		);
	});

	it('encodes view, q, cursor, and limit as query parameters', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(page));
		const client = createDashboardClient({ fetch: fetchMock });

		await client.worklist({ view: 'action_required', q: 'invoice', cursor: 'abc', limit: 10 });

		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/dashboard?view=action_required&q=invoice&cursor=abc&limit=10');
	});

	it('omits an empty search string from the request', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(page));
		const client = createDashboardClient({ fetch: fetchMock });

		await client.worklist({ q: '' });

		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/dashboard');
	});

	it('throws a typed DashboardApiError carrying the RFC 9457 problem fields on failure', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse(
				{
					type: 'urn:signkit:problem:instance-membership-required',
					title: 'Instance membership required',
					status: 403,
					detail: 'An active instance membership is required.',
					instance: '/api/v1/dashboard'
				},
				403
			)
		);
		const client = createDashboardClient({ fetch: fetchMock });

		await expect(client.worklist()).rejects.toMatchObject({
			status: 403,
			type: 'urn:signkit:problem:instance-membership-required'
		});
	});

	it('exposes the problem as a DashboardApiError instance', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}, 503));
		const client = createDashboardClient({ fetch: fetchMock });

		await expect(client.worklist()).rejects.toBeInstanceOf(DashboardApiError);
	});
});
