/**
 * Operator pages that a server listed in a d6e console sends to the console
 * instead of rendering: the dashboard (`/`), envelopes, settings, first-owner
 * setup, and the signed-out page. Every operation they offer is in the
 * console.
 *
 * Deliberately absent, so they keep working on every server: the recipient
 * pages (`/s`, `/sign`, `/c`), invitation acceptance by link
 * (`/invitations/accept`), the sign-in endpoints (`/auth/*`, which that
 * acceptance needs), and the API. Like the other surface helpers, an optional
 * leading locale segment is ignored.
 */
const CONSOLE_REDIRECTED_ROUTES: ReadonlySet<string> = new Set([
	'envelopes',
	'settings',
	'setup',
	'signed-out'
]);

export function isConsoleRedirectedPagePath(pathname: string): boolean {
	const segments: string[] = pathname
		.split('/')
		.filter((segment: string): boolean => segment.length > 0);
	const routeIndex: number = segments[0] === 'en' || segments[0] === 'ja' ? 1 : 0;
	const route: string | undefined = segments[routeIndex];
	if (route === undefined) return true;
	return CONSOLE_REDIRECTED_ROUTES.has(route);
}
