import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import type {
	DashboardItem,
	DashboardPage as DashboardPageData,
	DashboardQuery
} from '$lib/application/dashboard/model';
import type { PublicEnvelope } from '$lib/application/envelopes/model';
import DashboardPage from './+page.svelte';

function envelope(
	overrides: Partial<PublicEnvelope> & { id: string; title: string }
): PublicEnvelope {
	return {
		status: 'sent',
		updatedAt: '2026-09-12T00:00:00.000Z',
		createdAt: '2026-09-10T00:00:00.000Z',
		...overrides
	} as PublicEnvelope;
}

function item(overrides: Partial<DashboardItem> & { envelope: PublicEnvelope }): DashboardItem {
	return {
		recipient: null,
		recipientCount: 0,
		completedRecipientCount: 0,
		actionableRecipientCount: 0,
		nextRecipient: null,
		actionRequired: false,
		...overrides
	};
}

function worklistQuery(overrides: Partial<DashboardQuery> = {}): DashboardQuery {
	return { view: 'all', query: '', cursor: null, limit: 25, ...overrides };
}

function worklist(overrides: Partial<DashboardPageData> = {}): DashboardPageData {
	return {
		items: [],
		nextCursor: null,
		counts: { all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 },
		...overrides
	};
}

function pageData(overrides: {
	worklist?: DashboardPageData | null;
	worklistQuery?: DashboardQuery;
	worklistError?: { status: number; message: string } | null;
}) {
	return {
		worklist: 'worklist' in overrides ? overrides.worklist! : worklist(),
		worklistQuery: overrides.worklistQuery ?? worklistQuery(),
		worklistError: overrides.worklistError ?? null
	};
}

describe('dashboard worklist page in browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('renders rows from the data prop with no fetch call at all -- SSR owns the data', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const nda = envelope({ id: '01900000-0000-7000-8000-000000000001', title: 'NDA with Acme' });

		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ items: [item({ envelope: nda })] }) }) }
		});

		await expect.element(screen.getByText('NDA with Acme')).toBeVisible();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('shows whole-instance counts as tab badges, independent of the current query/page', async () => {
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 9, actionRequired: 3, waiting: 2, drafts: 1, completed: 3 }
					}),
					worklistQuery: worklistQuery({ query: 'acme' })
				})
			}
		});

		await expect.element(screen.getByRole('link', { name: /All/ })).toBeVisible();
		await expect.element(screen.getByRole('link', { name: /Action needed/ })).toBeVisible();
		await expect.element(screen.getByRole('link', { name: /Waiting on others/ })).toBeVisible();
		await expect.element(screen.getByRole('link', { name: /Drafts/ })).toBeVisible();
		await expect.element(screen.getByRole('link', { name: /Completed/ })).toBeVisible();
	});

	it('builds tab hrefs that preserve the current search query and drop any stale cursor', async () => {
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist(),
					worklistQuery: worklistQuery({ view: 'all', query: 'acme', cursor: 'stale-cursor' })
				})
			}
		});

		const draftsTab = screen.getByRole('link', { name: /Drafts/ });
		await expect.element(draftsTab).toBeVisible();
		const href = draftsTab.element().getAttribute('href') ?? '';
		expect(href).toContain('view=drafts');
		expect(href).toContain('q=acme');
		expect(href).not.toContain('cursor=');
	});

	it('marks the active tab with aria-current', async () => {
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklistQuery: worklistQuery({ view: 'waiting' }) }) }
		});

		const waitingTab = screen.getByRole('link', { name: /Waiting on others/ });
		await expect.element(waitingTab).toBeVisible();
		expect(waitingTab.element().getAttribute('aria-current')).toBe('page');
		const allTab = screen.getByRole('link', { name: /^All/ });
		expect(allTab.element().getAttribute('aria-current')).toBeNull();
	});

	it('renders the search field as a real GET form carrying the current view', async () => {
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklistQuery: worklistQuery({ view: 'drafts', query: 'beta' }) }) }
		});

		const input = screen.getByLabelText(m.dashboard_search_label());
		await expect.element(input).toBeVisible();
		expect((input.element() as HTMLInputElement).value).toBe('beta');
		const form = input.element().closest('form');
		expect(form?.getAttribute('method')?.toUpperCase()).toBe('GET');
		expect(form?.querySelector('input[name="view"]')).not.toBeNull();
		expect((form?.querySelector('input[name="view"]') as HTMLInputElement | null)?.value).toBe(
			'drafts'
		);
	});

	it('shows an explicit error with a retry action and never a fabricated zero count', async () => {
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: null,
					worklistError: { status: 503, message: 'Your agreements could not be loaded right now.' }
				})
			}
		});

		await expect
			.element(screen.getByText('Your agreements could not be loaded right now.'))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: m.common_retry() })).toBeVisible();
		expect(screen.getByRole('link', { name: /All \d/ }).query()).toBeNull();
	});

	it('shows the empty state when the view has no items, without a false error', async () => {
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ items: [] }) }) }
		});

		await expect.element(screen.getByText(m.dashboard_empty_title())).toBeVisible();
	});

	it('labels draft/ready rows "Continue editing" and others "Open", never a sign/approve shortcut', async () => {
		const draft = envelope({
			id: '01900000-0000-7000-8000-000000000001',
			title: 'Draft agreement',
			status: 'draft'
		});
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000002',
			title: 'Sent agreement',
			status: 'sent'
		});
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [
							item({ envelope: draft }),
							item({
								envelope: sent,
								actionRequired: true,
								recipient: { name: 'Jamie Signer', email: 'jamie@example.com' },
								nextRecipient: { name: 'Jamie Signer', email: 'jamie@example.com' }
							})
						]
					})
				})
			}
		});

		await expect.element(screen.getByRole('link', { name: /Continue editing/ })).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Open', exact: false }).nth(0))
			.toBeVisible();
		expect(screen.getByRole('link', { name: /Sign$/ }).query()).toBeNull();
		expect(screen.getByRole('link', { name: /Approve$/ }).query()).toBeNull();
	});

	it('links every row to the envelope detail page, never to a per-recipient signing/capability URL', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000003',
			title: 'Needs the other signer',
			status: 'sent'
		});
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [
							item({
								envelope: sent,
								recipient: { name: 'Other Signer', email: 'other@example.com' },
								nextRecipient: { name: 'Other Signer', email: 'other@example.com' }
							})
						]
					})
				})
			}
		});

		const link = screen.getByRole('link', { name: 'Needs the other signer' });
		await expect.element(link).toBeVisible();
		expect(link.element().getAttribute('href')).toMatch(
			/\/envelopes\/01900000-0000-7000-8000-000000000003$/
		);
	});

	it('preserves a terminal/voided envelope row in the All view', async () => {
		const voided = envelope({
			id: '01900000-0000-7000-8000-000000000004',
			title: 'Voided agreement',
			status: 'voided'
		});
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ items: [item({ envelope: voided })] }) }) }
		});

		await expect.element(screen.getByText('Voided agreement')).toBeVisible();
	});

	it('renders a next-page link built from the nextCursor, preserving the current view/query', async () => {
		const completed = envelope({
			id: '01900000-0000-7000-8000-000000000005',
			title: 'Completed agreement',
			status: 'completed'
		});
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({ items: [item({ envelope: completed })], nextCursor: 'abc123' }),
					worklistQuery: worklistQuery({ view: 'completed', query: 'msa' })
				})
			}
		});

		const nextLink = screen.getByRole('link', { name: m.dashboard_pagination_next() });
		await expect.element(nextLink).toBeVisible();
		const href = nextLink.element().getAttribute('href') ?? '';
		expect(href).toContain('cursor=abc123');
		expect(href).toContain('view=completed');
		expect(href).toContain('q=msa');
	});

	it('does not render a next-page link when there is no further cursor', async () => {
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ nextCursor: null }) }) }
		});

		expect(screen.getByRole('link', { name: m.dashboard_pagination_next() }).query()).toBeNull();
	});
});
