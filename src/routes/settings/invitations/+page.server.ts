import { redirect } from '@sveltejs/kit';
import { localizeHref } from '$lib/paraglide/runtime';
import type { PageServerLoad } from './$types';

/**
 * Server-side backstop for the client-side `SettingsAccessGate`: an
 * owner/admin-only route must never let unauthorized SSR markup reach the
 * response body for a plain member, a suspended member, or a non-member,
 * and a direct navigation or bookmark by any of them must redirect before
 * any of that renders. `/settings` is the correct redirect target: it is
 * the one page that already knows how to route each of those callers to
 * whatever they *are* allowed to see.
 */
export const load: PageServerLoad = async ({ parent }) => {
	const { instanceMemberRole } = await parent();
	if (instanceMemberRole !== 'owner' && instanceMemberRole !== 'admin') {
		redirect(302, localizeHref('/settings'));
	}
};
