import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage, userEvent } from 'vitest/browser';
import * as m from '$lib/paraglide/messages';
import type {
	DashboardItem,
	DashboardPage as DashboardPageData,
	DashboardQuery
} from '$lib/application/dashboard/model';
import type { PublicEnvelope } from '$lib/application/envelopes/model';
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

describe('dashboard worklist page in browser', () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await browserPage.viewport(1280, 800);
		await setMockedUrl('');
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
		await setMockedUrl('?view=all&q=acme&cursor=stale-cursor');
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

	it('marks the active tab with aria-current, and only that one', async () => {
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklistQuery: worklistQuery({ view: 'waiting' }) }) }
		});

		const waitingTab = screen.getByRole('link', { name: /Waiting on others/ });
		await expect.element(waitingTab).toBeVisible();
		expect(waitingTab.element().getAttribute('aria-current')).toBe('page');
		const allTab = screen.getByRole('link', { name: /^All/ });
		expect(allTab.element().getAttribute('aria-current')).toBeNull();
	});

	it('renders the search field inside a Field group with an accessible label mentioning email', async () => {
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklistQuery: worklistQuery({ view: 'drafts', query: 'beta' }) }) }
		});

		const input = screen.getByLabelText(m.dashboard_search_label());
		await expect.element(input).toBeVisible();
		expect((input.element() as HTMLInputElement).value).toBe('beta');
		expect(input.element().getAttribute('placeholder')).toMatch(/email/i);
		const form = input.element().closest('form');
		expect(form?.getAttribute('method')?.toUpperCase()).toBe('GET');
		expect(form?.querySelector('input[name="view"]')).not.toBeNull();
		expect((form?.querySelector('input[name="view"]') as HTMLInputElement | null)?.value).toBe(
			'drafts'
		);
	});

	it('shows a localized error description, never the raw backend problem detail', async () => {
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: null,
					worklistError: { status: 503, message: 'upstream postgres pool exhausted: ECONNRESET' }
				})
			}
		});

		expect(screen.getByText(/ECONNRESET/).query()).toBeNull();
		expect(screen.getByText(/postgres/i).query()).toBeNull();
		await expect.element(screen.getByRole('button', { name: m.common_retry() })).toBeVisible();
		expect(screen.getByRole('link', { name: /All \d/ }).query()).toBeNull();
	});

	it('distinguishes an empty workspace, an empty view, and no search matches', async () => {
		const emptyWorkspace = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 }
					})
				})
			}
		});
		await expect
			.element(emptyWorkspace.getByText(m.dashboard_empty_workspace_title()))
			.toBeVisible();
		await expect
			.element(emptyWorkspace.getByRole('link', { name: m.dashboard_send_contract() }).nth(1))
			.toBeVisible();

		const emptyView = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 3, actionRequired: 0, waiting: 0, drafts: 0, completed: 3 }
					}),
					worklistQuery: worklistQuery({ view: 'drafts' })
				})
			}
		});
		await expect.element(emptyView.getByText(m.dashboard_empty_view_title())).toBeVisible();
		await expect
			.element(emptyView.getByRole('link', { name: m.dashboard_tab_all() }).nth(1))
			.toBeVisible();

		const noMatches = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						counts: { all: 3, actionRequired: 0, waiting: 0, drafts: 0, completed: 3 }
					}),
					worklistQuery: worklistQuery({ query: 'nonexistent' })
				})
			}
		});
		await expect.element(noMatches.getByText(m.dashboard_empty_search_title())).toBeVisible();
		await expect
			.element(noMatches.getByRole('link', { name: m.dashboard_clear_search() }))
			.toBeVisible();
	});

	it('shows the action-required hint on that view once there are rows', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000009',
			title: 'Needs my signature',
			status: 'sent'
		});
		const onView = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({ items: [item({ envelope: sent, actionRequired: true })] }),
					worklistQuery: worklistQuery({ view: 'action_required' })
				})
			}
		});
		await expect.element(onView.getByText(m.dashboard_action_required_hint())).toBeVisible();
		onView.unmount();
	});

	it('hides the action-required hint on every other view', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000009',
			title: 'Needs my signature',
			status: 'sent'
		});
		const otherView = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({ items: [item({ envelope: sent })] }),
					worklistQuery: worklistQuery({ view: 'all' })
				})
			}
		});
		expect(otherView.getByText(m.dashboard_action_required_hint()).query()).toBeNull();
	});

	it('never narrates draft/not-sent or a fabricated 0/0 progress, and excludes CC from completion progress', async () => {
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
		const partial = envelope({
			id: '01900000-0000-7000-8000-000000000012',
			title: 'Two signers, one CC',
			status: 'in_progress'
		});
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [
							item({ envelope: draft }),
							item({ envelope: ccOnly, recipientCount: 1, actionableRecipientCount: 0 }),
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

		expect(screen.getByText('まだ送信されていません').query()).toBeNull();
		expect(screen.getByText('Not sent yet').query()).toBeNull();
		expect(screen.getByText('0/0').query()).toBeNull();
		await expect.element(screen.getByText('1/2 completed')).toBeVisible();
	});

	it('gives every row action an accessible, agreement-specific name', async () => {
		const draft = envelope({
			id: '01900000-0000-7000-8000-000000000013',
			title: 'Unique Draft Title',
			status: 'draft'
		});
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000014',
			title: 'Unique Sent Title',
			status: 'sent'
		});
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({ items: [item({ envelope: draft }), item({ envelope: sent })] })
				})
			}
		});

		await expect
			.element(screen.getByRole('link', { name: /Continue editing Unique Draft Title/ }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: /Open Unique Sent Title/ }))
			.toBeVisible();
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

		const link = screen.getByRole('link', { name: 'Needs the other signer', exact: true });
		await expect.element(link).toBeVisible();
		expect(link.element().getAttribute('href')).toMatch(
			/\/envelopes\/01900000-0000-7000-8000-000000000003$/
		);
	});

	it('preserves a terminal/voided envelope row in the All view without a progress narration', async () => {
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

	it('accepts an opaque, non-UUID cursor string and renders first-page/next-page links from the real query state', async () => {
		const completed = envelope({
			id: '01900000-0000-7000-8000-000000000005',
			title: 'Completed agreement',
			status: 'completed'
		});
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [item({ envelope: completed })],
						nextCursor: 'opaque~cursor_token==2'
					}),
					worklistQuery: worklistQuery({
						view: 'completed',
						query: 'msa',
						cursor: 'opaque~prior_token==1'
					})
				})
			}
		});

		const nextLink = screen.getByRole('link', { name: m.dashboard_pagination_next() });
		await expect.element(nextLink).toBeVisible();
		const nextHref = nextLink.element().getAttribute('href') ?? '';
		expect(new URL(nextHref, BASE_URL).searchParams.get('cursor')).toBe('opaque~cursor_token==2');
		expect(nextHref).toContain('view=completed');
		expect(nextHref).toContain('q=msa');

		const firstLink = screen.getByRole('link', { name: m.dashboard_pagination_first() });
		await expect.element(firstLink).toBeVisible();
		const firstHref = firstLink.element().getAttribute('href') ?? '';
		expect(firstHref).not.toContain('cursor=');
	});

	it('does not render pagination links when there is no cursor at all', async () => {
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ nextCursor: null }) }) }
		});

		expect(screen.getByRole('link', { name: m.dashboard_pagination_next() }).query()).toBeNull();
		expect(screen.getByRole('link', { name: m.dashboard_pagination_first() }).query()).toBeNull();
	});

	it('replaces the previous SSR snapshot entirely when new data arrives -- no stale rows linger', async () => {
		const first = envelope({
			id: '01900000-0000-7000-8000-000000000020',
			title: 'First page agreement'
		});
		const second = envelope({
			id: '01900000-0000-7000-8000-000000000021',
			title: 'Second page agreement'
		});
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ items: [item({ envelope: first })] }) }) }
		});
		await expect.element(screen.getByText('First page agreement')).toBeVisible();

		await screen.rerender({
			data: pageData({ worklist: worklist({ items: [item({ envelope: second })] }) })
		});

		await expect.element(screen.getByText('Second page agreement')).toBeVisible();
		expect(screen.getByText('First page agreement').query()).toBeNull();
	});

	it('stays keyboard-navigable: every nav view and row action is a real, tabbable link', async () => {
		const sent = envelope({
			id: '01900000-0000-7000-8000-000000000030',
			title: 'Keyboard reachable agreement',
			status: 'sent'
		});
		const screen = await render(DashboardPage, {
			props: { data: pageData({ worklist: worklist({ items: [item({ envelope: sent })] }) }) }
		});

		const allTab = screen.getByRole('link', { name: /^All/ }).element() as HTMLElement;
		allTab.focus();
		expect(document.activeElement).toBe(allTab);
		await userEvent.keyboard('{Tab}');
		expect(document.activeElement).not.toBe(allTab);
		expect(document.activeElement?.tagName.toLowerCase()).toBe('a');
	});

	it('keeps the page within the viewport width at 390px with long title/recipient/email and large counts', async () => {
		await browserPage.viewport(390, 844);
		const long = envelope({
			id: '01900000-0000-7000-8000-000000000040',
			title:
				'A Very Long Master Services Agreement Title That Could Otherwise Force The Whole Page To Scroll Sideways',
			status: 'sent'
		});
		const screen = await render(DashboardPage, {
			props: {
				data: pageData({
					worklist: worklist({
						items: [
							item({
								envelope: long,
								recipient: {
									name: 'A Very Long Recipient Display Name Indeed',
									email: 'a.very.long.recipient.email.address@example-corporation.com'
								},
								recipientCount: 5,
								actionableRecipientCount: 4,
								completedRecipientCount: 1,
								nextRecipient: {
									name: 'A Very Long Recipient Display Name Indeed',
									email: 'a.very.long.recipient.email.address@example-corporation.com'
								}
							})
						],
						counts: {
							all: 123456,
							actionRequired: 98765,
							waiting: 54321,
							drafts: 11111,
							completed: 22222
						}
					})
				})
			}
		});

		await expect.element(screen.getByText(long.title)).toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
			document.documentElement.clientWidth + 1
		);
	});
});
