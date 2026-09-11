import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('application layout shell', () => {
	const source: string = readFileSync('src/routes/+layout.svelte', 'utf8');

	it('keeps both application headers at the 64px h-16 height', () => {
		expect(source.match(/\bh-16\b/g)).toHaveLength(2);
		expect(source).not.toMatch(/\bh-14\b/);
	});

	it('uses the shadcn sidebar shell outside recipient surfaces', () => {
		expect(source).toContain('<Sidebar.Provider>');
		expect(source).toContain('<AppSidebar />');
		expect(source).toContain('<Sidebar.Inset');
		expect(source).toContain('<Sidebar.Trigger />');
	});
});
