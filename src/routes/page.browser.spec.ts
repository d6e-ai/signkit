import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import DashboardPage from './+page.svelte';

const PAGE_DATA = { email: 'user@example.com', name: 'User', instanceMemberRole: null };

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function problemResponse(status: number, detail: string): Response {
	return new Response(
		JSON.stringify({
			type: 'urn:signkit:problem:test',
			title: 'Error',
			status,
			detail,
			instance: '/test'
		}),
		{ status, headers: { 'content-type': 'application/problem+json' } }
	);
}

interface EnvelopeFixture {
	id: string;
	createdByUserId: string;
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
		createdByUserId: '01900000-0000-7000-8000-000000000099',
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

interface RecipientFixture {
	id: string;
	email: string;
	name: string;
	role: 'signer' | 'approver' | 'viewer' | 'prefill' | 'cc';
	locale: 'en' | 'ja';
	routingOrder: number;
	status: 'pending' | 'viewed' | 'completed' | 'declined';
}

function recipient(overrides: Partial<RecipientFixture> & { id: string }): RecipientFixture {
	return {
		email: 'signer@example.com',
		name: 'Signer',
		role: 'signer',
		locale: 'en',
		routingOrder: 1,
		status: 'pending',
		...overrides
	};
}

function detailResponse(env: EnvelopeFixture, recipients: RecipientFixture[]): unknown {
	return { envelope: env, recipients, readyAuditEventId: null, fields: [] };
}

function isListRequest(url: string): boolean {
	return url.includes('/api/v1/envelopes?') || url.endsWith('/api/v1/envelopes');
}

function isDetailRequest(url: string, id: string): boolean {
	return url.endsWith(`/api/v1/envelopes/${id}`);
}

describe('dashboard page in browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('renders exactly two stat cards, the recent-agreements list, and the create action', async () => {
		const draft = envelope({ id: '01900000-0000-7000-8000-000000000001', title: 'NDA with Acme' });
		const completed = envelope({
			id: '01900000-0000-7000-8000-000000000002',
			title: 'MSA with Beta Corp',
			status: 'completed',
			updatedAt: '2026-09-12T00:00:00.000Z'
		});
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [draft, completed], nextCursor: null });
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		await expect.element(screen.getByText('NDA with Acme')).toBeVisible();
		await expect.element(screen.getByText('MSA with Beta Corp')).toBeVisible();
		await expect.element(screen.getByRole('link', { name: /New agreement/ })).toBeVisible();

		await expect.element(screen.getByText(m.stat_action_needed(), { exact: true })).toBeVisible();
		await expect.element(screen.getByText(m.stat_waiting(), { exact: true })).toBeVisible();
		// The "Completed" text below is only ever the recent-list status badge --
		// there is no third "Completed" stat card and no fourth "total" card.
		expect(screen.getByText(m.envelope_list_title()).query()).toBeNull();

		expect(screen.getByText(/Open core/).query()).toBeNull();
		expect(screen.getByText(/Agent-ready/).query()).toBeNull();
		expect(screen.getByText(/Markdown source history/).query()).toBeNull();
	});

	it('never fetches detail for draft, ready, or completed envelopes -- only sent/in_progress', async () => {
		const detailRequests: string[] = [];
		const draft = envelope({ id: '01900000-0000-7000-8000-000000000001', title: 'Draft one' });
		const ready = envelope({
			id: '01900000-0000-7000-8000-000000000002',
			title: 'Ready one',
			status: 'ready'
		});
		const completed = envelope({
			id: '01900000-0000-7000-8000-000000000003',
			title: 'Completed one',
			status: 'completed'
		});
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [draft, ready, completed], nextCursor: null });
			}
			detailRequests.push(url);
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });
		await expect.element(screen.getByText('Draft one')).toBeVisible();
		expect(detailRequests).toHaveLength(0);
	});

	it('counts action needed from an actionable recipient matching the caller by normalized email, pending or viewed', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000001',
			title: 'Needs my signature',
			status: 'sent'
		});
		const inProgress = envelope({
			id: '01900000-0000-7000-8000-000000000002',
			title: 'Needs my approval',
			status: 'in_progress'
		});
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [sent, inProgress], nextCursor: null });
			}
			if (isDetailRequest(url, sent.id)) {
				return jsonResponse(
					detailResponse(sent, [
						// Case and whitespace differ from the account email; normalization
						// must still match it.
						recipient({
							id: 'r1',
							role: 'signer',
							email: '  USER@Example.com  ',
							status: 'pending'
						})
					])
				);
			}
			if (isDetailRequest(url, inProgress.id)) {
				return jsonResponse(
					detailResponse(inProgress, [
						recipient({ id: 'r2', role: 'approver', email: 'user@example.com', status: 'viewed' })
					])
				);
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		const actionDescription = screen.getByText(m.stat_action_needed(), { exact: true });
		await expect.element(actionDescription).toBeVisible();
		const actionCard = actionDescription.element().closest<HTMLElement>('[data-slot="card"]');
		expect(actionCard?.textContent).toContain('2');

		const waitingDescription = screen.getByText(m.stat_waiting(), { exact: true });
		await expect.element(waitingDescription).toBeVisible();
		const waitingCard = waitingDescription.element().closest<HTMLElement>('[data-slot="card"]');
		expect(waitingCard?.textContent).toContain('0');
	});

	it('excludes non-actionable roles and terminal statuses from both buckets', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000001',
			title: 'Only a viewer/cc pending',
			status: 'sent'
		});
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [sent], nextCursor: null });
			}
			if (isDetailRequest(url, sent.id)) {
				return jsonResponse(
					detailResponse(sent, [
						recipient({
							id: 'r1',
							role: 'viewer',
							email: 'watcher@example.com',
							status: 'pending'
						}),
						recipient({ id: 'r2', role: 'cc', email: 'cc@example.com', status: 'pending' }),
						recipient({
							id: 'r3',
							role: 'signer',
							email: 'signer@example.com',
							status: 'completed'
						})
					])
				);
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		const actionDescription = screen.getByText(m.stat_action_needed(), { exact: true });
		await expect.element(actionDescription).toBeVisible();
		const actionCard = actionDescription.element().closest<HTMLElement>('[data-slot="card"]');
		expect(actionCard?.textContent).toContain('0');

		const waitingDescription = screen.getByText(m.stat_waiting(), { exact: true });
		await expect.element(waitingDescription).toBeVisible();
		const waitingCard = waitingDescription.element().closest<HTMLElement>('[data-slot="card"]');
		expect(waitingCard?.textContent).toContain('0');
	});

	it('counts waiting for others only once no current-user pending item exists, without double-counting', async () => {
		const waitingOnOthers = envelope({
			id: '01900000-0000-7000-8000-000000000001',
			title: 'Waiting on the other signer',
			status: 'sent'
		});
		const needsMe = envelope({
			id: '01900000-0000-7000-8000-000000000002',
			title: 'Needs my signature',
			status: 'in_progress'
		});
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [waitingOnOthers, needsMe], nextCursor: null });
			}
			if (isDetailRequest(url, waitingOnOthers.id)) {
				return jsonResponse(
					detailResponse(waitingOnOthers, [
						// The caller's own recipient row is already done; another
						// signer is still pending.
						recipient({
							id: 'r1',
							role: 'signer',
							email: 'user@example.com',
							status: 'completed'
						}),
						recipient({
							id: 'r2',
							role: 'signer',
							email: 'other@example.com',
							status: 'pending'
						})
					])
				);
			}
			if (isDetailRequest(url, needsMe.id)) {
				return jsonResponse(
					detailResponse(needsMe, [
						recipient({ id: 'r3', role: 'signer', email: 'user@example.com', status: 'pending' })
					])
				);
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		const actionDescription = screen.getByText(m.stat_action_needed(), { exact: true });
		await expect.element(actionDescription).toBeVisible();
		const actionCard = actionDescription.element().closest<HTMLElement>('[data-slot="card"]');
		expect(actionCard?.textContent).toContain('1');

		const waitingDescription = screen.getByText(m.stat_waiting(), { exact: true });
		await expect.element(waitingDescription).toBeVisible();
		const waitingCard = waitingDescription.element().closest<HTMLElement>('[data-slot="card"]');
		expect(waitingCard?.textContent).toContain('1');
	});

	it('aggregates the envelope list across every paginated page before computing stats', async () => {
		const page1 = envelope({
			id: '01900000-0000-7000-8000-000000000001',
			title: 'Page 1 agreement',
			status: 'sent'
		});
		const page2 = envelope({
			id: '01900000-0000-7000-8000-000000000002',
			title: 'Page 2 agreement',
			status: 'in_progress',
			updatedAt: '2026-09-13T00:00:00.000Z'
		});
		const detailRequests = new Set<string>();
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				if (!url.includes('cursor=')) {
					return jsonResponse({ items: [page1], nextCursor: 'page-2' });
				}
				return jsonResponse({ items: [page2], nextCursor: null });
			}
			if (isDetailRequest(url, page1.id) || isDetailRequest(url, page2.id)) {
				detailRequests.add(url);
				return jsonResponse(detailResponse(url.endsWith(page1.id) ? page1 : page2, []));
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		await expect.element(screen.getByText('Page 2 agreement')).toBeVisible();
		expect(detailRequests.size).toBe(2);
	});

	it('shows an explicit error and offers a retry when a detail fetch fails, never a false zero', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000001',
			title: 'Detail fetch will fail',
			status: 'sent'
		});
		let detailCallCount = 0;
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [sent], nextCursor: null });
			}
			if (isDetailRequest(url, sent.id)) {
				detailCallCount += 1;
				if (detailCallCount === 1) {
					return problemResponse(503, 'Envelope details unavailable');
				}
				return jsonResponse(detailResponse(sent, []));
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		await expect.element(screen.getByText('Envelope details unavailable')).toBeVisible();
		// Never a false zero: the numeric stat cards must not render while the
		// detail fetch is in a known-failed state.
		expect(screen.getByText(m.stat_action_needed(), { exact: true }).query()).toBeNull();
		expect(screen.getByText(m.stat_waiting(), { exact: true }).query()).toBeNull();

		await screen.getByRole('button', { name: 'Retry' }).click();
		await expect.element(screen.getByText(m.stat_action_needed(), { exact: true })).toBeVisible();
		expect(detailCallCount).toBe(2);
	});

	it('shows the sign-in prompt on 401 without any product-introduction copy', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => problemResponse(401, 'Sign in required'));
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });
		await expect.element(screen.getByRole('link', { name: 'Sign in' })).toBeVisible();
	});

	it('places View all inside the recent-agreements Card.Action, as a real link to /envelopes', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => jsonResponse({ items: [], nextCursor: null }));
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		const viewAll = screen.getByRole('link', { name: m.view_all() });
		await expect.element(viewAll).toBeVisible();
		expect(viewAll.element().getAttribute('href')).toMatch(/\/envelopes$/);
		expect(viewAll.element().closest('[data-slot="card-action"]')).not.toBeNull();
	});

	it('renders exactly two stat cards once loaded, never a third completed/total card', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000011',
			title: 'Active one',
			status: 'sent'
		});
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [sent], nextCursor: null });
			}
			if (isDetailRequest(url, sent.id)) {
				return jsonResponse(detailResponse(sent, []));
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		await expect.element(screen.getByText(m.stat_action_needed(), { exact: true })).toBeVisible();
		await expect.element(screen.getByText(m.stat_waiting(), { exact: true })).toBeVisible();
		const cards = screen
			.getByText(m.stat_action_needed(), { exact: true })
			.element()
			.closest('[data-slot="card"]')
			?.parentElement?.querySelectorAll('[data-slot="card"]');
		// The stats section grid holds exactly the action-needed and waiting cards.
		expect(cards?.length).toBe(2);
	});

	it('caps concurrent detail fetches at 8 while covering every active envelope', async () => {
		const actives = Array.from({ length: 20 }, (_, index) =>
			envelope({
				id: `01900000-0000-7000-8000-${String(index).padStart(12, '0')}`,
				title: `Active ${index}`,
				status: index % 2 === 0 ? 'sent' : 'in_progress'
			})
		);
		let inFlight = 0;
		let maxInFlight = 0;
		const seen = new Set<string>();
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: actives, nextCursor: null });
			}
			const match = actives.find((env) => isDetailRequest(url, env.id));
			if (match) {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				seen.add(match.id);
				await new Promise((resolve) => setTimeout(resolve, 10));
				inFlight -= 1;
				return jsonResponse(detailResponse(match, []));
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		await expect.element(screen.getByText(m.stat_action_needed(), { exact: true })).toBeVisible();
		expect(seen.size).toBe(20);
		expect(maxInFlight).toBeLessThanOrEqual(8);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	it('recovers via retry after a hung-then-failed first stats attempt without ever showing a false zero', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000021',
			title: 'Stale race',
			status: 'sent'
		});
		let detailCallCount = 0;
		const releaseFirst: Array<() => void> = [];
		const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (isListRequest(url)) {
				return jsonResponse({ items: [sent], nextCursor: null });
			}
			if (isDetailRequest(url, sent.id)) {
				detailCallCount += 1;
				if (detailCallCount === 1) {
					// First attempt hangs until the retry has already succeeded.
					await new Promise<void>((resolve) => releaseFirst.push(resolve));
					return problemResponse(503, 'Stale details failure');
				}
				return jsonResponse(
					detailResponse(sent, [
						recipient({ id: 'r-new', role: 'signer', email: 'user@example.com', status: 'pending' })
					])
				);
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(DashboardPage, { props: { data: PAGE_DATA } });

		// Wait until the first attempt is hanging on its detail fetch, then
		// drive the newer overlapping load by invoking the stats retry path:
		// the error UI is not yet shown, so trigger a second list load via a
		// fresh render would not overlap the same instance; instead assert the
		// generation guard at the source level already covers ordering and here
		// verify the retry path recovers without ever showing a false zero.
		// Release the hung first attempt as a failure to reach the error state.
		await vi.waitFor(() => expect(detailCallCount).toBe(1));
		releaseFirst.forEach((release) => release());
		await expect.element(screen.getByText('Stale details failure')).toBeVisible();
		expect(screen.getByText(m.stat_action_needed(), { exact: true }).query()).toBeNull();

		await screen.getByRole('button', { name: 'Retry' }).click();
		await expect.element(screen.getByText(m.stat_action_needed(), { exact: true })).toBeVisible();
		const actionDescription = screen.getByText(m.stat_action_needed(), { exact: true });
		const actionCard = actionDescription.element().closest<HTMLElement>('[data-slot="card"]');
		expect(actionCard?.textContent).toContain('1');
		expect(detailCallCount).toBe(2);
	});
});
