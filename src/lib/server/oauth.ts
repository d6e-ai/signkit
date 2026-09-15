export const OAUTH_STATE_COOKIE = 'signkit_oauth_state';
export const OAUTH_RETURN_COOKIE = 'signkit_oauth_return';

// Fixed, non-routable placeholder origin used purely to anchor URL parsing
// for canonicalization; it is never dereferenced.
const TRUSTED_RETURN_ORIGIN = 'https://signkit.internal.invalid';

// Matches ASCII control characters (including DEL) and backslash. Built from
// character codes rather than a literal escape range so no raw control byte
// ends up embedded in this source file.
const CONTROL_OR_BACKSLASH = new RegExp(
	'[' +
		Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('') +
		String.fromCharCode(0x7f) +
		'\\\\' +
		']'
);

/**
 * Validates a post-login return path against the current origin.
 *
 * Only same-origin `path[?query][#hash]` values starting with a single `/`
 * are accepted. Everything else -- protocol-relative `//host`, absolute
 * URLs, backslashes, ASCII control characters, and their percent-encoded
 * equivalents -- is rejected, since each can smuggle a different
 * scheme/host past a naive `startsWith('/')` check once a browser or proxy
 * resolves the value (e.g. `/\attacker.example` is treated as
 * `//attacker.example` by URL parsers for special schemes, and raw
 * tab/CR/LF are stripped from URLs before parsing).
 */
export function safeReturnPath(value: string | null | undefined): string | null {
	if (!value) return null;

	// Reject raw control characters and backslashes outright, plus their
	// percent-encoded forms, so no parser-specific decoding quirk can turn
	// an apparently same-origin path into a cross-origin redirect.
	if (CONTROL_OR_BACKSLASH.test(value)) return null;
	if (/%(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;

	if (!value.startsWith('/') || value.startsWith('//')) return null;

	let url: URL;
	try {
		url = new URL(value, TRUSTED_RETURN_ORIGIN);
	} catch {
		return null;
	}
	if (url.origin !== TRUSTED_RETURN_ORIGIN) return null;

	return `${url.pathname}${url.search}${url.hash}`;
}
