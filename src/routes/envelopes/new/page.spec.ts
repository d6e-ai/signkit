import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('new envelope page', () => {
	const source: string = readFileSync('src/routes/envelopes/new/+page.svelte', 'utf8');

	it('keeps the card footer free of a decorative separator', () => {
		expect(source).toContain('<Card.Footer class="justify-end gap-2">');
		expect(source).not.toMatch(/<Card\.Footer[^>]*(?:border-t|bg-muted)/);
	});
});
