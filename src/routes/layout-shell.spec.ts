import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('recipient layout shell', () => {
	const source: string = readFileSync('src/routes/+layout.svelte', 'utf8');

	it('keeps the header at the 64px h-16 height', () => {
		expect(source.match(/\bh-16\b/g)).toHaveLength(1);
		expect(source).not.toMatch(/\bh-14\b/);
	});

	it('renders no operator sidebar or account controls', () => {
		expect(source).not.toMatch(
			/AppSidebar|Sidebar\.|AppBreadcrumbs|data\.email|instanceMemberRole/
		);
	});

	it('applies the stored theme before paint via ModeWatcher', () => {
		expect(source).toContain("import { ModeWatcher } from 'mode-watcher';");
		expect(source).toContain('<ModeWatcher />');
	});

	it('places the theme switch next to the language switch', () => {
		expect(source.match(/<ThemeSwitch \/>/g)).toHaveLength(1);
		expect(source.match(/<LanguageSwitch \/>/g)).toHaveLength(1);
	});

	it('links the brand nowhere, since this server has no home page', () => {
		expect(source).not.toMatch(/<a href="\/"/);
	});

	it('has exactly one main landmark', () => {
		expect(source.match(/<main\b/g)).toHaveLength(1);
	});
});
