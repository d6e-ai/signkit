import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function findPageFiles(dir: string): string[] {
	const results: string[] = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...findPageFiles(fullPath));
		} else if (entry.isFile() && entry.name === '+page.svelte') {
			results.push(fullPath);
		}
	}
	return results;
}

const PAGE_FILES = findPageFiles('src/routes');

describe('project-wide page-width contract', () => {
	it('recursively discovers all route +page.svelte files', () => {
		expect(PAGE_FILES.length).toBeGreaterThanOrEqual(12);
	});

	it('ensures no +page.svelte file has explicit max-w-* width constraints other than max-w-none', () => {
		const violations: { file: string; matches: string[] }[] = [];
		const explicitMaxWidthPattern = /\b(?:[\w:[\]=-]+:)*max-w-(?!none\b)[^\s"'`>]+/g;

		for (const file of PAGE_FILES) {
			const source = readFileSync(file, 'utf8');
			const matches = source.match(explicitMaxWidthPattern) ?? [];
			if (matches.length > 0) {
				violations.push({ file, matches });
			}
		}

		expect(
			violations,
			`Found unexpected explicit max-w-* width constraints in route pages:\n${violations
				.map((v) => `  ${v.file}: ${v.matches.join(', ')}`)
				.join('\n')}`
		).toEqual([]);
	});

	it.each(PAGE_FILES)('verifies %s complies with the page-width contract', (file) => {
		const source = readFileSync(file, 'utf8');
		const matches = source.match(/\b(?:[\w:[\]=-]+:)*max-w-(?!none\b)[^\s"'`>]+/g) ?? [];
		expect(matches, `Explicit max-w-* constraint found in ${file}`).toEqual([]);
	});
});
