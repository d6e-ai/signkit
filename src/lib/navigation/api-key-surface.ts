/**
 * The only request paths on which a `signkit_` API key bearer token is resolved
 * into an authority at all.
 *
 * This is an allowlist, not a denylist, so a route added tomorrow is closed to
 * API keys until someone deliberately opens it. Everything outside it -- API key
 * and instance management, the recipient signing surface, public completion
 * artifacts, the system drains, and every browser page -- never resolves an API
 * key, so a key presented there cannot authenticate no matter what the endpoint
 * handler does.
 *
 * Membership here only means "an API key may be resolved on this path". It does
 * not mean every endpoint under it accepts one: handlers still require the
 * matching live grant scope. The two layers are independent on purpose --
 * widening this list can never by itself grant a key a mutation.
 */
const API_KEY_PATH_PREFIXES: readonly string[] = ['/api/v1/envelopes'];

/**
 * Management paths where presenting a `signkit_` API key is an error rather than
 * something to ignore.
 *
 * Not resolving a key here would not be enough. If the header were merely
 * ignored, a request carrying both an API key and a browser cookie would be
 * authorized by the cookie, which is exactly the escalation path an API key must
 * never have: minting another key, granting itself an organization, or
 * administering instance members. Treating the key as a hard rejection also
 * suppresses the cookie for that request, so the two authorities can never
 * compose on the surfaces where composing them would matter most.
 */
const API_KEY_REJECTED_PATH_PREFIXES: readonly string[] = [
	'/api/v1/api-keys',
	'/api/v1/instance',
	'/api/v1/webhooks'
];

/**
 * Instance bootstrap is deliberately exempt.
 *
 * Its `Authorization` header is not a credential-family selector at all: it
 * carries `SIGNKIT_BOOTSTRAP_SECRET`, which is checked constant-time *before*
 * identity precisely so an invalid or unconfigured secret returns an opaque 404.
 * A `signkit_`-shaped value there is simply a wrong deployment secret and
 * already fails closed on that path, so classifying it as an API key would
 * change a documented flow without adding any protection.
 */
const BOOTSTRAP_PATH: string = '/api/v1/instance/bootstrap';

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
	return prefixes.some(
		(prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

export function isApiKeyAuthenticatedPath(pathname: string): boolean {
	return matchesPrefix(pathname, API_KEY_PATH_PREFIXES);
}

export function isApiKeyRejectedPath(pathname: string): boolean {
	if (pathname === BOOTSTRAP_PATH) return false;
	return matchesPrefix(pathname, API_KEY_REJECTED_PATH_PREFIXES);
}
