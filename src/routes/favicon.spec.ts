import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GET } from './favicon.ico/+server';

describe('favicon assets', () => {
	it('declares the canonical static SVG on every layout surface', () => {
		const layout: string = readFileSync('src/routes/+layout.svelte', 'utf8');
		const favicon: string = readFileSync('static/favicon.svg', 'utf8');

		expect(layout).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
		expect(favicon).toMatch(/^<svg\b/);
		expect(favicon).toContain('<title>SignKit</title>');
	});

	it('redirects the conventional ico request to the canonical icon', async () => {
		const response: Response = await GET({} as never);

		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('/favicon.svg');
		expect(response.headers.get('cache-control')).toContain('public');
	});
});
