import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import SettingsPage from './+page.svelte';

describe('settings instance-management page server contracts', () => {
	it('renders SSR initial loading shell without crashing', () => {
		const { body } = render(SettingsPage);
		expect(body).toContain('Loading members…');
		expect(body).toContain('mx-auto max-w-6xl space-y-6');
	});

	it('requires each-block keys on all collections', () => {
		// All #each blocks in the component must be keyed. This is a structural
		// anti-pattern guard, not a claim about feature behavior: an unkeyed
		// each over a mutable list causes Svelte to misattribute DOM nodes
		// across reorders. Behavior itself is covered by page.browser.spec.ts.
		const source = readFileSync('src/routes/settings/+page.svelte', 'utf8');
		const eachMatches = [...source.matchAll(/\{#each\s+([^}]+)\}/g)];
		expect(eachMatches.length).toBeGreaterThan(0);
		for (const match of eachMatches) {
			const expr = match[1];
			// Svelte keyed each block has form: `items as item (key)`
			expect(expr).toMatch(/\(.*?\)$/);
		}
	});
});
