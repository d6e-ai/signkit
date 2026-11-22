import { env } from '$env/dynamic/private';
import { parseInstanceInvitationConsoleUrl } from '$lib/application/instance-invitations/instance-invitation-delivery-service';

/**
 * The d6e console that lists this server (`SIGNKIT_CONSOLE_URL`), read from
 * the Worker environment first, then the process environment. Returns the
 * normalized URL, or null when unset, blank, or not an acceptable absolute
 * https URL; null means a standalone server.
 */
export function resolveConsoleUrl(platform?: Readonly<App.Platform>): string | null {
	const raw: string | undefined = platform?.env?.SIGNKIT_CONSOLE_URL ?? env.SIGNKIT_CONSOLE_URL;
	const trimmed: string = raw?.trim() ?? '';
	if (trimmed.length === 0) return null;
	return parseInstanceInvitationConsoleUrl(trimmed);
}
