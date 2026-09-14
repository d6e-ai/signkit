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

describe('dashboard page', () => {
	it('renders the SSR initial loading shell without crashing', () => {
		const { body } = render(DashboardPage);
		expect(body).toContain('mx-auto flex w-full max-w-7xl flex-col gap-6');
	});

	it('never renders the removed product-introduction/Markdown/Git/agent-native copy', () => {
		const { body } = render(DashboardPage);
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

	it('keeps the primary create-agreement action and the recent-agreements block', () => {
		const source: string = readFileSync('src/routes/+page.svelte', 'utf8');
		expect(source).toContain('m.new_agreement()');
		expect(source).toContain('m.recent_title()');
		expect(source).toContain('m.stat_action_needed()');
		expect(source).toContain('m.stat_waiting()');
		expect(source).toContain('m.stat_completed()');
	});
});
