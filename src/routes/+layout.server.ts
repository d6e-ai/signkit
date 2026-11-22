import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { isRecipientSurfacePath } from '$lib/navigation/recipient-surface';
import { resolveConsoleUrl } from '$lib/server/console-url';

/**
 * This server renders only recipient pages (`/s`, `/sign`, `/c`): their
 * visitors authenticate with capability links, never with an operator
 * session. Operators work in the d6e console that lists this server
 * (`SIGNKIT_CONSOLE_URL`), so every other page path -- including old
 * dashboard, envelope, settings, setup, and invitation links -- redirects
 * there. A server without a valid console URL is misconfigured and answers
 * 503 instead.
 *
 * Done in the layout rather than a hook so SvelteKit also returns the redirect
 * in its data-request form during client-side navigation.
 */
export const load: LayoutServerLoad = async ({ platform, url }) => {
	if (isRecipientSurfacePath(url.pathname)) return {};
	const consoleUrl: string | null = resolveConsoleUrl(platform);
	if (consoleUrl === null) {
		error(503, 'This SignKit server is not registered with a d6e console.');
	}
	redirect(302, consoleUrl);
};
