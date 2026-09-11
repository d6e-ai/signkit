import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('recipient document rendering', () => {
	it('renders untrusted Markdown only through escaped Svelte text interpolation', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
		expect(source).toContain('{document.content}');
		expect(source).not.toContain('{@html');
		expect(source).not.toMatch(/<img[^>]+document\.content|href=\{document\.content\}/);
	});
});
