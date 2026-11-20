/**
 * Name of the deployer-owned environment variable listing the browser origins
 * of operator consoles that may call this deployment's operator API
 * cross-origin. The value is a comma-separated list of exact origins
 * (`https://console.example.com`). Absent or blank turns cross-origin console
 * access off; an invalid entry turns it off as well (fail closed).
 */
export const CONSOLE_ORIGINS_ENV_VAR = 'SIGNKIT_CONSOLE_ORIGINS' as const;

export class ConsoleOriginsPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConsoleOriginsPolicyError';
	}
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Canonicalizes one configured origin. Only a bare `scheme://host[:port]`
 * (optionally with one trailing `/`) is accepted -- no wildcard, `null`,
 * credentials, path, query, or fragment -- and
 * the scheme must be HTTPS, except HTTP for an exact loopback host during local
 * development, mirroring the `D6E_AUTH_BASE_URL` rule. The canonical form is
 * the WHATWG serialization browsers send in the `Origin` header, so the
 * per-request comparison is a plain string match.
 */
function canonicalizeConsoleOrigin(entry: string): string {
	// WHATWG URL accepts `*` in a host, so `https://*.example.com` would
	// otherwise parse into an origin no browser can ever send.
	if (entry.includes('*')) {
		throw new ConsoleOriginsPolicyError('Console origin entries must not contain wildcards');
	}
	let url: URL;
	try {
		url = new URL(entry);
	} catch {
		throw new ConsoleOriginsPolicyError('Console origin entries must be absolute origins');
	}
	if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new ConsoleOriginsPolicyError(
			'Console origin entries must not contain credentials, a path, a query, or a fragment'
		);
	}
	// An empty query or fragment (`https://console.example.com?`) parses to an
	// empty `search`/`hash`, so the raw text is checked as well. A single
	// trailing slash is the only tolerated decoration.
	if (entry.includes('?') || entry.includes('#')) {
		throw new ConsoleOriginsPolicyError('Console origin entries must be bare origins');
	}
	if (url.protocol === 'https:') return url.origin;
	if (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname)) return url.origin;
	throw new ConsoleOriginsPolicyError(
		'Console origin entries must use HTTPS (HTTP is only permitted for loopback hosts)'
	);
}

/**
 * Parses a raw `SIGNKIT_CONSOLE_ORIGINS` value into the set of allowed origins.
 * Returns an empty set when the value is absent or blank. Throws
 * `ConsoleOriginsPolicyError` when any entry is invalid; callers treat that as
 * an empty set and never echo the configured value.
 */
export function parseConsoleOrigins(raw: string | undefined | null): ReadonlySet<string> {
	if (raw === undefined || raw === null || raw.trim().length === 0) return new Set();
	const origins: Set<string> = new Set();
	for (const entry of raw.split(',')) {
		const trimmed: string = entry.trim();
		if (trimmed.length === 0) {
			throw new ConsoleOriginsPolicyError('Console origin entries must not be empty');
		}
		origins.add(canonicalizeConsoleOrigin(trimmed));
	}
	return origins;
}
