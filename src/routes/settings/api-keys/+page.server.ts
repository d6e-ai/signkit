import { redirect } from '@sveltejs/kit';
import { localizeHref } from '$lib/paraglide/runtime';
import type { PageServerLoad } from './$types';

/**
 * Server-side backstop for the client-side `SettingsAccessGate`. API keys
 * are scoped to the caller's own account, so any active member may reach
 * this route -- only a suspended member or a non-member is redirected, and
 * that redirect must happen before SSR renders any admin-adjacent markup,
 * not rely on a client-side effect to bounce them back afterward.
 */
export const load: PageServerLoad = async ({ parent }) => {
	const { instanceMemberRole } = await parent();
	if (instanceMemberRole === null) {
		redirect(302, localizeHref('/settings'));
	}
};
