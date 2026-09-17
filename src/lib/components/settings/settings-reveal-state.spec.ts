import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsRevealState } from './settings-reveal-state.svelte';

describe('settings browser-memory-only reveal state', () => {
	const source: string = readFileSync(
		'src/lib/components/settings/settings-reveal-state.svelte.ts',
		'utf8'
	);

	beforeEach(() => {
		vi.stubGlobal('window', {
			location: { href: 'http://localhost/en/settings' }
		} as unknown as Window & typeof globalThis);
		vi.useFakeTimers();
		settingsRevealState.dismissRevealedApiKey();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		settingsRevealState.dismissRevealedApiKey();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('never persists via storage, cookies, URL, or server data and guards every mutation to the browser', () => {
		// Strip block and line comments so explanatory docs mentioning
		// localStorage/sessionStorage don't trip the guard; executable
		// persistence calls would still remain and fail below.
		const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		expect(executableSource).not.toMatch(/localStorage|sessionStorage/);
		expect(source).not.toMatch(/document\.cookie|cookies?\.set/);
		expect(source).not.toMatch(/URLSearchParams|goto\(|pushState|replaceState/);
		expect(source).not.toMatch(/fetch\(|\/api\//);
		// Every public mutator plus the panel teardown must bail during SSR
		// so a Worker isolate never leaks one caller's secret into another's render.
		const guardedCount = source.match(/if \(typeof window === 'undefined'\) return;/g) ?? [];
		expect(guardedCount.length).toBeGreaterThanOrEqual(4);
		expect(source).not.toContain('revealedInvitation');
		expect(source).toContain('teardownApiKeysPanel');
	});

	it('does nothing during SSR when window is absent, never leaking a secret', () => {
		vi.unstubAllGlobals();
		expect(typeof window).toBe('undefined');
		settingsRevealState.setRevealedApiKey({
			secret: 'ssr-secret',
			keyId: 'key-ssr',
			keyName: 'SSR'
		});
		expect(settingsRevealState.revealedApiKey).toBeNull();
	});

	it('survives settings child-route navigation: teardown keeps the API key but resets copy feedback and timers', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
		} as unknown as Navigator);
		settingsRevealState.setRevealedApiKey({
			secret: 'secret-nav',
			keyId: 'key-nav',
			keyName: 'Nav'
		});
		await settingsRevealState.copyApiKeySecret('secret-nav');
		expect(settingsRevealState.apiKeyCopied).toBe(true);
		settingsRevealState.teardownApiKeysPanel();
		expect(settingsRevealState.revealedApiKey?.secret).toBe('secret-nav');
		expect(settingsRevealState.apiKeyCopied).toBe(false);
		expect(settingsRevealState.apiKeyCopyError).toBeNull();
	});

	it('dismisses the secret and resets its copy feedback', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
		} as unknown as Navigator);
		settingsRevealState.setRevealedApiKey({ secret: 'secret-a', keyId: 'key-a', keyName: 'A' });
		await settingsRevealState.copyApiKeySecret('secret-a');
		expect(settingsRevealState.revealedApiKey?.secret).toBe('secret-a');

		settingsRevealState.dismissRevealedApiKey();
		expect(settingsRevealState.revealedApiKey).toBeNull();
		expect(settingsRevealState.apiKeyCopied).toBe(false);
	});

	it('resets copy feedback on a new API key and auto-clears Copied! via timeout cleanup', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
		} as unknown as Navigator);
		settingsRevealState.setRevealedApiKey({ secret: 'secret-1', keyId: 'key-1', keyName: 'One' });
		await settingsRevealState.copyApiKeySecret('secret-1');
		expect(settingsRevealState.apiKeyCopied).toBe(true);

		settingsRevealState.setRevealedApiKey({ secret: 'secret-2', keyId: 'key-2', keyName: 'Two' });
		expect(settingsRevealState.revealedApiKey?.secret).toBe('secret-2');
		expect(settingsRevealState.apiKeyCopied).toBe(false);

		await settingsRevealState.copyApiKeySecret('secret-2');
		expect(settingsRevealState.apiKeyCopied).toBe(true);
		// Advancing past the 2s window clears the indicator; clearing the
		// timer on teardown/new-secret prevents a stale clear after unmount.
		await vi.advanceTimersByTimeAsync(2100);
		expect(settingsRevealState.apiKeyCopied).toBe(false);
	});

	it('surfaces a clipboard failure without losing the secret, and clears it on the next secret', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
		} as unknown as Navigator);
		settingsRevealState.setRevealedApiKey({ secret: 'secret-1', keyId: 'key-1', keyName: 'One' });
		await settingsRevealState.copyApiKeySecret('secret-1');
		expect(settingsRevealState.apiKeyCopyError).toContain('Could not copy');
		expect(settingsRevealState.revealedApiKey?.secret).toBe('secret-1');

		settingsRevealState.setRevealedApiKey({ secret: 'secret-2', keyId: 'key-2', keyName: 'Two' });
		expect(settingsRevealState.revealedApiKey?.secret).toBe('secret-2');
		expect(settingsRevealState.apiKeyCopyError).toBeNull();
	});
});
