import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import DashboardPage from './+page.svelte';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

interface EnvelopeFixture {
	id: string;
	organizationId: string;
	title: string;
	status: 'draft' | 'ready' | 'sent' | 'in_progress' | 'completed';
	repositoryGeneration: number;
	repositoryHead: string | null;
	repositoryArchiveSha256: string | null;
	sentCommitSha: string | null;
	fieldGeneration: number;
	createdAt: string;
	updatedAt: string;
}

function envelope(
	overrides: Partial<EnvelopeFixture> & { id: string; title: string }
): EnvelopeFixture {
	return {
		organizationId: 'org-1',
		status: 'draft',
		repositoryGeneration: 0,
		repositoryHead: null,
		repositoryArchiveSha256: null,
		sentCommitSha: null,
		fieldGeneration: 0,
		createdAt: '2026-09-10T00:00:00.000Z',
		updatedAt: '2026-09-10T00:00:00.000Z',
		...overrides
	};
}

describe('dashboard page in browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('renders status counts, the recent-agreements list, and the create action', async () => {
		const mockFetch = vi.fn().mockImplementation(async () =>
			jsonResponse({
				items: [
					envelope({
						id: '01900000-0000-7000-8000-000000000001',
						title: 'NDA with Acme',
						status: 'draft'
					}),
					envelope({
						id: '01900000-0000-7000-8000-000000000002',
						title: 'MSA with Beta Corp',
						status: 'completed',
						updatedAt: '2026-09-12T00:00:00.000Z'
					})
				],
				nextCursor: null
			})
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage);

		await expect.element(screen.getByText('NDA with Acme')).toBeVisible();
		await expect.element(screen.getByText('MSA with Beta Corp')).toBeVisible();
		await expect.element(screen.getByRole('link', { name: /New agreement/ })).toBeVisible();

		// Removed product-introduction copy must never resurface once real data
		// has loaded either.
		expect(screen.getByText(/Open core/).query()).toBeNull();
		expect(screen.getByText(/Agent-ready/).query()).toBeNull();
		expect(screen.getByText(/Markdown source history/).query()).toBeNull();
	});

	it('aggregates counts across every paginated page, not just the first', async () => {
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url: string = typeof input === 'string' ? input : input.toString();
			if (!url.includes('cursor=')) {
				return jsonResponse({
					items: [
						envelope({
							id: '01900000-0000-7000-8000-000000000001',
							title: 'Page 1 agreement',
							status: 'completed'
						})
					],
					nextCursor: 'page-2'
				});
			}
			return jsonResponse({
				items: [
					envelope({
						id: '01900000-0000-7000-8000-000000000002',
						title: 'Page 2 agreement',
						status: 'completed',
						updatedAt: '2026-09-13T00:00:00.000Z'
					})
				],
				nextCursor: null
			});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage);

		await expect.element(screen.getByText('Page 2 agreement')).toBeVisible();
		expect(mockFetch).toHaveBeenCalledTimes(2);

		// "Completed" also appears as the status badge text on both recent-agreement
		// rows, so scope the match to the stat card's description element.
		const completedLabel = screen
			.getByText(m.stat_completed())
			.elements()
			.find((element) => element.getAttribute('data-slot') === 'card-description');
		await expect.element(completedLabel ?? null).toBeVisible();
		const completedCard = completedLabel?.closest('[data-slot="card"]');
		expect(completedCard?.textContent).toContain('2');
	});

	it('labels the completed stat without claiming a this-month scope it does not compute', () => {
		expect(m.stat_completed()).not.toMatch(/month/i);
	});

	it('shows the sign-in prompt on 401 without any product-introduction copy', async () => {
		const mockFetch = vi.fn().mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						type: 'urn:signkit:problem:test',
						title: 'Unauthorized',
						status: 401,
						detail: 'Sign in required',
						instance: '/test'
					}),
					{ status: 401, headers: { 'content-type': 'application/problem+json' } }
				)
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage);
		await expect.element(screen.getByRole('link', { name: 'Sign in' })).toBeVisible();
	});
});
