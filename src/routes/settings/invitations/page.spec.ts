import { readFileSync } from 'node:fs';
import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import InvitationsPage from './+page.svelte';

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

const { load: invitationsGuard } = await import('./+page.server');

describe('settings invitations page server contracts', () => {
	it('renders SSR initial loading shell without crashing', () => {
		const { body } = render(InvitationsPage);
		expect(body).toContain('Loading page…');
	});

	it('requires each-block keys on all collections in the invitations panel', () => {
		const source = readFileSync(
			'src/lib/components/settings/settings-invitations-panel.svelte',
			'utf8'
		);
		const eachMatches = [...source.matchAll(/\{#each\s+([^}]+)\}/g)];
		expect(eachMatches.length).toBeGreaterThan(0);
		for (const match of eachMatches) {
			expect(match[1]).toMatch(/\(.*?\)$/);
		}
	});

	it('never renders a Tabs-based instance-administration UI', () => {
		const pageSource = readFileSync('src/routes/settings/invitations/+page.svelte', 'utf8');
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-invitations-panel.svelte',
			'utf8'
		);
		expect(pageSource).not.toMatch(/ui\/tabs/);
		expect(panelSource).not.toMatch(/ui\/tabs/);
	});

	it('keeps the invitation FieldError inside its associated invalid Field with data-invalid and aria-invalid', () => {
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-invitations-panel.svelte',
			'utf8'
		);
		expect(panelSource).toMatch(
			/<Field\.Field[^>]*data-invalid=\{inviteCreateError !== null\}[^>]*>[\s\S]*?<Field\.FieldError>\{inviteCreateError\}<\/Field\.FieldError>[\s\S]*?<\/Field\.Field>/
		);
		expect(panelSource).toMatch(/aria-invalid=\{inviteCreateError !== null\}/);
	});

	it('keeps the role select as Select.Content > Select.Group > Select.Item with no raw select/label/space-y', () => {
		const panelSource = readFileSync(
			'src/lib/components/settings/settings-invitations-panel.svelte',
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

describe('settings invitations page server guard', () => {
	it('lets an owner/admin reach the route without redirecting', async () => {
		for (const role of ['owner', 'admin'] as const) {
			const result = await invitationsGuard({
				parent: async () => ({ instanceMemberRole: role })
			} as never);
			expect(result).toBeUndefined();
		}
	});

	it('redirects a plain member, suspended caller (null role), or non-member to /settings before SSR', async () => {
		for (const role of ['member', null] as const) {
			const redirected = await captureRedirect(
				invitationsGuard({ parent: async () => ({ instanceMemberRole: role }) } as never)
			);
			expect(redirected.status).toBe(302);
			expect(redirected.location).toBe('/settings');
		}
	});
});
