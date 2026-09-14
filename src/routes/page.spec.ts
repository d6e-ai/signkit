import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import DashboardPage from './+page.svelte';

const REMOVED_COPY: readonly string[] = [
	'Open core',
	'Agent native',
	'Agent-ready',
	'Markdown source history',
	'Git revisions',
	'agent_ready',
	'source_history'
];

const PAGE_DATA = { email: 'user@example.com', name: 'User', instanceMemberRole: null };

describe('dashboard page', () => {
	it('renders the SSR initial loading shell without crashing', () => {
		const { body } = render(DashboardPage, { props: { data: PAGE_DATA } });
		expect(body).toContain('mx-auto flex w-full max-w-7xl flex-col gap-6');
	});

	it('titles the page Dashboard, not Agreements', () => {
		const { body } = render(DashboardPage, { props: { data: PAGE_DATA } });
		const h1Match = body.match(/<h1[^>]*>([^<]*)<\/h1>/);
		expect(h1Match).not.toBeNull();
		expect(h1Match?.[1].trim()).toBe('Dashboard');
	});

	it('never renders the removed product-introduction/Markdown/Git/agent-native copy', () => {
		const { body } = render(DashboardPage, { props: { data: PAGE_DATA } });
		for (const copy of REMOVED_COPY) {
			expect(body).not.toContain(copy);
		}
	});

	it('drops the product-introduction copy and blocks from the source, not just the loading state', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		for (const copy of REMOVED_COPY) {
			expect(source).not.toContain(copy);
		}
		expect(source).not.toMatch(/IconBrandGit|IconRobot|IconClock/);
	});

	it('keeps exactly the two action-needed/waiting stat cards, dropping completed and total', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		expect(source).toContain('m.new_agreement()');
		expect(source).toContain('m.recent_title()');
		expect(source).toContain('m.stat_action_needed()');
		expect(source).toContain('m.stat_waiting()');
		expect(source).not.toContain('m.stat_completed()');
		expect(source).not.toContain('m.envelope_list_title()');
	});

	it('places View all in a Card.Action, right-aligned and vertically aligned with the title', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		const recentHeaderMatch = source.match(
			/<Card\.Header>\s*<Card\.Title>\{m\.recent_title\(\)\}<\/Card\.Title>\s*<Card\.Description>\{m\.recent_description\(\)\}<\/Card\.Description>\s*<Card\.Action>/
		);
		expect(recentHeaderMatch).not.toBeNull();
		expect(source).toContain('m.view_all()');
	});

	it('fetches envelope detail only for active (sent/in_progress) envelopes', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		expect(source).toMatch(/envelope\.status === 'sent' \|\| envelope\.status === 'in_progress'/);
		expect(source).toContain('client.getDetail(targets[index].id)');
	});

	it('classifies a current-user pending item by normalized email and actionable pending/viewed status', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		expect(source).toContain('isActionableRecipientRole(recipient.role)');
		expect(source).toContain('normalizeEmail(recipient.email) === normalizedSelfEmail');
		expect(source).toMatch(/recipient\.status === 'pending' \|\| recipient\.status === 'viewed'/);
	});

	it('caps concurrent detail fetches at 8 or fewer while still covering every active envelope', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		const concurrencyMatch = source.match(/const DETAIL_FETCH_CONCURRENCY = (\d+);/);
		expect(concurrencyMatch).not.toBeNull();
		const concurrency = Number(concurrencyMatch?.[1]);
		expect(concurrency).toBeLessThanOrEqual(8);
		expect(concurrency).toBeGreaterThan(0);
		expect(source).toContain('Math.min(DETAIL_FETCH_CONCURRENCY, targets.length)');
		expect(source).toContain('await Promise.all(Array.from({ length: workerCount }');
	});

	it('publishes counts/error/loading only from the newest overlapping stats load and invalidates on destroy', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		expect(source).toContain('let statsRequestGeneration = 0;');
		expect(source).toMatch(/const generation = \+\+statsRequestGeneration;/);
		expect(source).toMatch(/generation !== statsRequestGeneration/);
		// Both success and failure paths must bail when stale, and the empty
		// fast-path must too, so a slow first attempt never overwrites a
		// faster retry with stale zeros or a stale failure.
		expect(source).toMatch(/if \(isStale\(\)\) return;/);
		expect(source).toContain('let destroyed = false;');
		expect(source).toMatch(/onDestroy\(\(\) => \{\s*destroyed = true;/);
		expect(source).toMatch(/destroyed \|\| generation !== statsRequestGeneration/);
	});

	it('disables the stats retry while a retry is already loading', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		expect(source).toMatch(
			/disabled=\{statsLoading\}[\s\S]*?onclick=\{\(\) => void loadStats\(\)\}/
		);
	});
});
