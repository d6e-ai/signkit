import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type {
	DashboardItem,
	DashboardPage as DashboardPageData,
	DashboardQuery
} from '$lib/application/dashboard/model';
import type { PublicEnvelope } from '$lib/application/envelopes/model';
import * as m from '$lib/paraglide/messages';
import DashboardPage from './+page.svelte';

const { BASE_URL } = vi.hoisted(() => ({ BASE_URL: 'https://signkit.example' }));

vi.mock('$app/state', () => ({
	page: {
		url: new URL(`${BASE_URL}/`),
		params: {},
		route: { id: '/' },
		status: 200,
		error: null,
		data: {},
		form: null,
		state: {}
	}
}));

async function setMockedUrl(search: string): Promise<void> {
	const { page: mockedPage } = await import('$app/state');
	(mockedPage as { url: URL }).url = new URL(`${BASE_URL}/${search}`);
}

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

describe('dashboard worklist page SSR', () => {
	it('renders the shared layout shell, not a nested max-width container', async () => {
		await setMockedUrl('');
		const { body } = render(DashboardPage, { props: { data: pageData({}) } });
		expect(body).toContain('flex w-full flex-col gap-6');
		expect(body).not.toContain('max-w-7xl');
		expect(body).not.toContain('mx-auto');
		expect(body).not.toContain('max-w-64');
	});

	it('titles the page Dashboard', async () => {
		await setMockedUrl('');
		const { body } = render(DashboardPage, { props: { data: pageData({}) } });
		const h1Match = body.match(/<h1[^>]*>([^<]*)<\/h1>/);
		expect(h1Match).not.toBeNull();
		expect(h1Match?.[1].trim()).toBe('Dashboard');
	});

	it('renders the worklist rows straight from the data prop, with nothing fetched during SSR', async () => {
		await setMockedUrl('');
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const nda = envelope({ id: '01900000-0000-7000-8000-000000000001', title: 'NDA with Acme' });
		const { body } = render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ items: [item({ envelope: nda })] }) }) }
		});
		expect(body).toContain('NDA with Acme');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('renders all five views with whole-instance counts, independent of the current query', async () => {
		await setMockedUrl('?q=acme');
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 7, actionRequired: 2, waiting: 1, drafts: 3, completed: 1 }
					}),
					worklistQuery: worklistQuery({ query: 'acme' })
				})
			}
		});
		for (const label of ['All', 'Action needed', 'Waiting on others', 'Drafts', 'Completed']) {
			expect(body).toContain(label);
		}
		expect(body).toContain('>7<');
		expect(body).toContain('>2<');
	});

	it('builds the next-view href from the current query, even if the ambient URL lacks it', async () => {
		await setMockedUrl('');
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({ worklistQuery: worklistQuery({ view: 'all', query: 'needs search' }) })
			}
		});
		expect(body).toMatch(/href="[^"]*view=drafts[^"]*q=needs(%20|\+)search/);
	});

	it('shows a localized error description derived only from status, never the raw backend detail', async () => {
		await setMockedUrl('');
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: null,
					worklistError: { status: 503, message: 'upstream postgres pool exhausted: ECONNRESET' }
				})
			}
		});
		expect(body).not.toContain('ECONNRESET');
		expect(body).not.toContain('postgres');
		expect(body).toContain('temporarily unavailable');
	});

	it('shows the empty-workspace state when counts.all is zero', async () => {
		await setMockedUrl('');
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 }
					})
				})
			}
		});
		expect(body).toContain('Send your first contract');
	});

	it('shows the empty-view state when other envelopes exist but none match this view', async () => {
		await setMockedUrl('?view=drafts');
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 3, actionRequired: 0, waiting: 0, drafts: 0, completed: 3 }
					}),
					worklistQuery: worklistQuery({ view: 'drafts' })
				})
			}
		});
		expect(body).toContain('Nothing here right now');
	});

	it('shows the no-search-matches state when a query yields nothing, distinct from the other empties', async () => {
		await setMockedUrl('?q=nonexistent');
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 3, actionRequired: 0, waiting: 0, drafts: 0, completed: 3 }
					}),
					worklistQuery: worklistQuery({ query: 'nonexistent' })
				})
			}
		});
		expect(body).toContain('No matches for your search');
		expect(body).toContain('Clear search');
	});

	it('excludes CC recipients from completion progress (uses actionableRecipientCount, not recipientCount)', async () => {
		await setMockedUrl('');
		const partial = envelope({
			id: '01900000-0000-7000-8000-000000000012',
			title: 'Two signers, one CC',
			status: 'in_progress'
		});
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [
							item({
								envelope: partial,
								recipientCount: 3,
								actionableRecipientCount: 2,
								completedRecipientCount: 1
							})
						]
					})
				})
			}
		});
		expect(body).toContain('1/2 completed');
		expect(body).not.toContain('1/3 completed');
	});

	it('never shows a fabricated 0/0 progress or draft/not-sent narration the status badge already covers', async () => {
		await setMockedUrl('');
		const draft = envelope({
			id: '01900000-0000-7000-8000-000000000010',
			title: 'Draft agreement',
			status: 'draft'
		});
		const ccOnly = envelope({
			id: '01900000-0000-7000-8000-000000000011',
			title: 'CC only, sent',
			status: 'sent'
		});
		const voided = envelope({
			id: '01900000-0000-7000-8000-000000000013',
			title: 'Voided agreement',
			status: 'voided'
		});
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [
							item({ envelope: draft }),
							item({ envelope: ccOnly, recipientCount: 1, actionableRecipientCount: 0 }),
							item({ envelope: voided })
						]
					})
				})
			}
		});
		expect(body).not.toContain('まだ送信されていません');
		expect(body).not.toContain('Not sent yet');
		expect(body).not.toMatch(/0\/0/);
	});

	it('gives the row action link an accessible, agreement-specific name', async () => {
		await setMockedUrl('');
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000014',
			title: 'Unique Sent Title',
			status: 'sent'
		});
		const { body } = render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ items: [item({ envelope: sent })] }) }) }
		});
		expect(body).toContain('aria-label="Open Unique Sent Title"');
	});

	it('shows the action-required hint only on that view, never implying an in-page sign/approve button', async () => {
		await setMockedUrl('?view=action_required');
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000009',
			title: 'Needs my signature',
			status: 'sent'
		});
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({ items: [item({ envelope: sent, actionRequired: true })] }),
					worklistQuery: worklistQuery({ view: 'action_required' })
				})
			}
		});
		expect(body).toContain(m.dashboard_action_required_hint());
	});

	it('shows a first-page link only once a cursor is present in the query, alongside next-page', async () => {
		await setMockedUrl('?cursor=opaque-token-1');
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000015',
			title: 'Paged agreement',
			status: 'sent'
		});
		const { body } = render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [item({ envelope: sent })],
						nextCursor: 'opaque-token-2'
					}),
					worklistQuery: worklistQuery({ cursor: 'opaque-token-1' })
				})
			}
		});
		expect(body).toContain('First page');
		expect(body).toContain('Next page');
	});

	it('does not render ARIA tab roles for the view switcher (navigation, not a client-side tablist)', async () => {
		await setMockedUrl('');
		const { body } = render(DashboardPage, { props: { data: pageData({}) } });
		expect(body).not.toContain('role="tablist"');
		expect(body).not.toContain('role="tab"');
	});
});
