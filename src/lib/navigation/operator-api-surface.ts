/**
 * The operator `/api/v1` surface: every endpoint a signed-in instance member
 * drives, as opposed to the recipient signing surface, public completion
 * artifacts, the system drains and maintenance endpoints, and public discovery.
 *
 * Two independent features key off this list:
 *
 * - a d6e-auth access token presented as `Authorization: Bearer` is verified
 *   only here, and then stands in for the operator cookie session;
 * - cross-origin console access (`SIGNKIT_CONSOLE_ORIGINS`) is answered only
 *   here, plus the read-only discovery endpoints below.
 *
 * Like the API key allowlist this is an allowlist, not a denylist: a route
 * added tomorrow under a new prefix is closed to both until someone opens it
 * deliberately. `/api/v1/signing`, `/api/v1/recipient`,
 * `/api/v1/completion-artifacts`, and `/api/v1/system` are intentionally
 * absent.
 */
const OPERATOR_API_PATH_PREFIXES: readonly string[] = [
	'/api/v1/api-keys',
	'/api/v1/contacts',
	'/api/v1/dashboard',
	'/api/v1/envelopes',
	'/api/v1/instance',
	'/api/v1/webhooks'
];

/**
 * Public, credential-free discovery endpoints a console may read cross-origin
 * before it holds a token: they are opened for `GET` (and `HEAD`) only.
 */
const CONSOLE_DISCOVERY_PATHS: ReadonlySet<string> = new Set([
	'/api/v1/system/capabilities',
	'/api/v1/openapi.json'
]);

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
	return prefixes.some(
		(prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

export function isOperatorApiPath(pathname: string): boolean {
	return matchesPrefix(pathname, OPERATOR_API_PATH_PREFIXES);
}

/**
 * Which console CORS policy applies to `pathname`, if any.
 *
 * - `operator`: the operator surface, every method the API uses.
 * - `discovery`: public discovery, `GET`/`HEAD` only.
 * - `null`: no cross-origin access at all, whatever the configured origins.
 */
export type ConsoleCorsSurface = 'operator' | 'discovery' | null;

export function consoleCorsSurface(pathname: string): ConsoleCorsSurface {
	if (isOperatorApiPath(pathname)) return 'operator';
	if (CONSOLE_DISCOVERY_PATHS.has(pathname)) return 'discovery';
	return null;
}
