import { readFileSync } from 'node:fs';
import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import MembersPage from './+page.svelte';

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

const { load: membersGuard } = await import('./+page.server');

describe('settings members page server contracts', () => {
	it('renders SSR initial loading shell without crashing', () => {
		const { body } = render(MembersPage);
		expect(body).toContain('Loading page…');
	});

	it('requires each-block keys on all collections in the members panel', () => {
		const source = readFileSync(
			'src/lib/components/settings/settings-members-panel.svelte',
			'utf8'
		);
		const eachMatches = [...source.matchAll(/\{#each\s+([^}]+)\}/g)];
		expect(eachMatches.length).toBeGreaterThan(0);
		for (const match of eachMatches) {
			expect(match[1]).toMatch(/\(.*?\)$/);
		}
	});

	it('never renders a Tabs-based instance-administration UI', () => {
		const pageSource = readFileSync('src/routes/settings/members/+page.svelte', 'utf8');
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-members-panel.svelte',
			'utf8'
		);
		expect(pageSource).not.toMatch(/ui\/tabs/);
		expect(panelSource).not.toMatch(/ui\/tabs/);
	});

	it('keeps role selects as Select.Content > Select.Group > Select.Item with no raw select/label/space-y', () => {
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-members-panel.svelte',
			'utf8'
		);
		expect(panelSource).toContain('<Select.Content>');
		expect(panelSource).toContain('<Select.Group>');
		expect(panelSource).toContain('<Select.Item');
		expect(panelSource).not.toMatch(/<select[\s>]/);
		expect(panelSource).not.toMatch(/<label[\s>]/);
		expect(panelSource).not.toContain('space-y');
	});
});

describe('settings members page server guard', () => {
	it('lets an owner/admin reach the route without redirecting', async () => {
		for (const role of ['owner', 'admin'] as const) {
			const result = await membersGuard({
				parent: async () => ({ instanceMemberRole: role })
			} as never);
			expect(result).toBeUndefined();
		}
	});

	it('redirects a plain member, suspended caller (null role), or non-member to /settings before SSR', async () => {
		for (const role of ['member', null] as const) {
			const redirected = await captureRedirect(
				membersGuard({ parent: async () => ({ instanceMemberRole: role }) } as never)
			);
			expect(redirected.status).toBe(302);
			expect(redirected.location).toBe('/settings');
		}
	});
});
