import { readFileSync } from 'node:fs';
import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ApiKeysPage from './+page.svelte';

function stripLocalePrefix(pathname: string): string {
	return pathname.replace(/^\/(en|ja)(?=\/|$)/, '') || '/';
}

async function captureRedirect(result: unknown): Promise<{ status: number; location: string }> {
	try {
		await result;
	} catch (error: unknown) {
		if (isRedirect(error))
			return { status: error.status, location: stripLocalePrefix(error.location) };
		throw error;
	}
	throw new Error('expected a redirect to be thrown');
}

const { load: apiKeysGuard } = await import('./+page.server');

describe('settings api-keys page server contracts', () => {
	it('renders SSR initial loading shell without crashing', () => {
		const { body } = render(ApiKeysPage);
		expect(body).toContain('Loading page…');
	});

	it('requires each-block keys on all collections in the api-keys panel', () => {
		const source = readFileSync(
			'src/lib/components/settings/settings-api-keys-panel.svelte',
			'utf8'
		);
		const eachMatches = [...source.matchAll(/\{#each\s+([^}]+)\}/g)];
		expect(eachMatches.length).toBeGreaterThan(0);
		for (const match of eachMatches) {
			expect(match[1]).toMatch(/\(.*?\)$/);
		}
	});

	it('never renders a Tabs-based instance-administration UI', () => {
		const pageSource = readFileSync('src/routes/settings/api-keys/+page.svelte', 'utf8');
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-api-keys-panel.svelte',
			'utf8'
		);
		expect(pageSource).not.toMatch(/ui\/tabs/);
		expect(panelSource).not.toMatch(/ui\/tabs/);
	});

	it('keeps the API-key FieldError inside its associated invalid Field with data-invalid and aria-invalid', () => {
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-api-keys-panel.svelte',
			'utf8'
		);
		expect(panelSource).toMatch(
			/<Field\.Field[^>]*data-invalid=\{keyCreateError !== null\}[^>]*>[\s\S]*?<Field\.FieldError>\{keyCreateError\}<\/Field\.FieldError>[\s\S]*?<\/Field\.Field>/
		);
		expect(panelSource).toMatch(/aria-invalid=\{keyCreateError !== null\}/);
	});

	it('warns operators that organization grants are durable delegations without automatic revocation', () => {
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-api-keys-panel.svelte',
			'utf8'
		);
		expect(panelSource).toContain('settings_api_keys_grant_durability_title');
		expect(panelSource).toContain('settings_api_keys_grant_durability_warning');
		expect(panelSource).toMatch(/role="note"/);
	});

	it('defines the grant durability warning in every locale', async () => {
		const { default: en } = (await import('../../../../messages/en.json')) as {
			default: Record<string, string>;
		};
		const { default: ja } = (await import('../../../../messages/ja.json')) as {
			default: Record<string, string>;
		};
		for (const key of [
			'settings_api_keys_grant_durability_title',
			'settings_api_keys_grant_durability_warning'
		] as const) {
			expect(en[key]).toMatch(/grant/i);
			expect(ja[key].length).toBeGreaterThan(0);
		}
		expect(en.settings_api_keys_grant_durability_warning).toContain('automatically');
	});
});

describe('settings api-keys page server guard', () => {
	it('lets any active member (owner/admin/member) reach the route without redirecting', async () => {
		for (const role of ['owner', 'admin', 'member'] as const) {
			const result = await apiKeysGuard({
				parent: async () => ({ instanceMemberRole: role })
			} as never);
			expect(result).toBeUndefined();
		}
	});

	it('redirects a suspended caller or non-member (null role) to /settings before SSR', async () => {
		const redirected = await captureRedirect(
			apiKeysGuard({ parent: async () => ({ instanceMemberRole: null }) } as never)
		);
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe('/settings');
	});
});
