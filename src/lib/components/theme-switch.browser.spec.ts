import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { setMode } from 'mode-watcher';
import ThemeSwitchTestHost from './theme-switch-test-host.svelte';

describe('theme switch', () => {
	afterEach(() => {
		setMode('system');
	});

	it('offers light, dark, and system modes', async () => {
		const screen = await render(ThemeSwitchTestHost);

		await screen.getByRole('button', { name: 'Theme' }).click();
		await expect.element(screen.getByRole('menuitem', { name: /Light/ })).toBeVisible();
		await expect.element(screen.getByRole('menuitem', { name: /Dark/ })).toBeVisible();
		await expect.element(screen.getByRole('menuitem', { name: /System/ })).toBeVisible();
	});

	it('switches the document to dark mode when Dark is chosen', async () => {
		const screen = await render(ThemeSwitchTestHost);

		await screen.getByRole('button', { name: 'Theme' }).click();
		await screen.getByRole('menuitem', { name: /Dark/ }).click();

		await expect.poll(() => document.documentElement.classList.contains('dark')).toBe(true);
	});
});
