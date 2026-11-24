import { env } from '$env/dynamic/private';

/**
 * Accepts only an absolute https URL without credentials or fragment, so a
 * misconfigured value can never send a browser to another scheme or carry a
 * secret. Returns the normalized URL, or null when the value is not
 * acceptable.
 */
export function parseConsoleUrl(value: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.hash !== '' ||
		parsed.href.length > 2048
	) {
		return null;
	}
	return parsed.href;
}

/**
 * The d6e console that lists this server (`SIGNKIT_CONSOLE_URL`), read from
 * the Worker environment first, then the process environment. Returns the
 * normalized URL, or null when unset, blank, or unacceptable: a server without
 * one is not registered with a console and cannot be operated.
 */
export function resolveConsoleUrl(platform?: Readonly<App.Platform>): string | null {
	const raw: string | undefined = platform?.env?.SIGNKIT_CONSOLE_URL ?? env.SIGNKIT_CONSOLE_URL;
	const trimmed: string = raw?.trim() ?? '';
	if (trimmed.length === 0) return null;
	return parseConsoleUrl(trimmed);
}
