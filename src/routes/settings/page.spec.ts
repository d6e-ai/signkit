import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import SettingsPage from './+page.svelte';

describe('settings entry page server contracts', () => {
	it('renders SSR initial loading shell without crashing', () => {
		const { body } = render(SettingsPage);
		expect(body).toContain('Loading page…');
		expect(body).toContain('flex flex-col gap-6');
		expect(body).not.toContain('max-w-6xl');
		expect(body).not.toContain('mx-auto');
	});

	it('never renders a Tabs-based instance-administration UI', () => {
		const { body } = render(SettingsPage);
		expect(body).not.toMatch(/role="tablist"/);
	});
});
