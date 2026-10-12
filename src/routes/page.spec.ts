import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dashboard worklist page contracts', () => {
	const source: string = readFileSync('src/routes/+page.svelte', 'utf8');

	it('renders the shared layout shell, not a nested max-width container', () => {
		expect(source).toContain('flex w-full flex-col gap-6');
		expect(source).not.toContain('max-w-7xl');
		expect(source).not.toContain('mx-auto');
	});

	it('titles the page Dashboard and links the main CTA to the new-envelope route', () => {
		expect(source).toMatch(/<h1[^>]*>\{m\.dashboard_title\(\)\}<\/h1>/);
		expect(source).toContain("localizeHref('/envelopes/new')");
		expect(source).toContain('m.dashboard_send_contract()');
	});

	it('does not show a sign-in prompt -- the layout gate already handles anonymous/non-member callers', () => {
		expect(source).not.toContain('signInHref');
		expect(source).not.toContain('m.sign_in()');
	});

	it('renders all five worklist views with whole-instance counts independent of the query/page', () => {
		for (const view of ['all', 'action_required', 'waiting', 'drafts', 'completed']) {
			expect(source).toContain(`'${view}'`);
		}
		expect(source).toContain('m.dashboard_tab_all()');
		expect(source).toContain('m.dashboard_tab_action_required()');
		expect(source).toContain('m.dashboard_tab_waiting()');
		expect(source).toContain('m.dashboard_tab_drafts()');
		expect(source).toContain('m.dashboard_tab_completed()');
		// Counts come from `data.worklist.counts`, never a fabricated literal, and
		// the count badge is only rendered once a worklist actually loaded.
		expect(source).toMatch(
			/\{#if data\.worklist\}[\s\S]*?viewTabCount\(view, data\.worklist\.counts\)/
		);
	});

	it('builds tab/search/pagination links from the SvelteKit URL, never a client API fetch', () => {
		expect(source).not.toContain('createEnvelopesClient');
		expect(source).not.toContain('onMount');
		expect(source).toContain('function buildHref(');
		expect(source).toContain('method="GET"');
	});

	it('shows the dashboard-specific error message and a retry action, with no fabricated zero counts', () => {
		expect(source).toMatch(/\{#if data\.worklistError\}/);
		expect(source).toContain('data.worklistError.message');
		expect(source).toContain('m.common_retry()');
		expect(source).toContain('void invalidateAll()');
	});

	it('shows the empty state only once an error is ruled out', () => {
		expect(source).toMatch(
			/\{#if data\.worklistError\}[\s\S]*?\{:else if data\.worklist === null \|\| data\.worklist\.items\.length === 0\}/
		);
		expect(source).toContain('m.dashboard_empty_title()');
	});

	it('labels draft/ready rows "Continue editing" and everything else "Open", never a sign/approve shortcut', () => {
		expect(source).toContain('m.dashboard_row_action_continue()');
		expect(source).toContain('m.dashboard_row_action_open()');
		expect(source).not.toMatch(/m\.\w*sign\w*\(\)/i);
		expect(source).not.toMatch(/m\.\w*approve\w*\(\)/i);
	});

	it('links rows to the envelope detail page only, never a per-recipient capability URL', () => {
		expect(source).toContain('localizeHref(`/envelopes/${item.envelope.id}`)');
		expect(source).not.toContain('/c/');
	});

	it('scores completion progress against actionableRecipientCount, not recipientCount (which includes CC)', () => {
		expect(source).toContain('total: item.actionableRecipientCount');
	});
});
