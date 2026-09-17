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

function isDelimiter(char: string): boolean {
	return (
		char <= ' ' ||
		char === '"' ||
		char === "'" ||
		char === '`' ||
		char === '<' ||
		char === '>' ||
		char === '{' ||
		char === '}' ||
		char === ';'
	);
}

function isExplicitMaxWidthToken(token: string): boolean {
	const idx = token.lastIndexOf('max-w-');
	if (idx === -1) {
		return false;
	}

	if (idx > 0) {
		const prev = token[idx - 1];
		if (prev !== ':' && prev !== '!') {
			return false;
		}
	}

	const utility = token.slice(idx);
	if (utility.length <= 'max-w-'.length) {
		return false;
	}

	if (utility === 'max-w-none' || utility === 'max-w-none!') {
		return false;
	}

	return true;
}

function findExplicitMaxWidthViolations(source: string): string[] {
	const violations: string[] = [];
	let start = -1;

	for (let i = 0; i <= source.length; i++) {
		const char = i < source.length ? source[i] : ' ';
		if (isDelimiter(char)) {
			if (start !== -1) {
				const token = source.slice(start, i);
				if (isExplicitMaxWidthToken(token)) {
					violations.push(token);
				}
				start = -1;
			}
		} else if (start === -1) {
			start = i;
		}
	}

	return violations;
}

describe('project-wide page-width contract', () => {
	it('recursively discovers all route +page.svelte files', () => {
		expect(PAGE_FILES.length).toBeGreaterThanOrEqual(12);
	});

	it('rejects explicit max-w-* constraints while allowing max-w-none and prose max-w-none', () => {
		expect(findExplicitMaxWidthViolations('max-w-6xl')).toEqual(['max-w-6xl']);
		expect(findExplicitMaxWidthViolations('sm:max-w-md')).toEqual(['sm:max-w-md']);
		expect(findExplicitMaxWidthViolations('max-w-[calc(...)]')).toEqual(['max-w-[calc(...)]']);
		expect(findExplicitMaxWidthViolations('max-w-none')).toEqual([]);
		expect(findExplicitMaxWidthViolations('prose max-w-none')).toEqual([]);
	});

	it('ensures no +page.svelte file has explicit max-w-* width constraints other than max-w-none', () => {
		const violations: { file: string; matches: string[] }[] = [];

		for (const file of PAGE_FILES) {
			const source = readFileSync(file, 'utf8');
			const matches = findExplicitMaxWidthViolations(source);
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
		const matches = findExplicitMaxWidthViolations(source);
		expect(matches, `Explicit max-w-* constraint found in ${file}`).toEqual([]);
	});
});
