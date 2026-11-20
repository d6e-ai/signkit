/**
 * The operator `/api/v1` surface: every endpoint a signed-in instance member
 * drives, as opposed to the recipient signing surface, public completion
 * artifacts, the system drains and maintenance endpoints, and public discovery.
 *
 * A d6e-auth access token presented as `Authorization: Bearer` is verified
 * only here, and then stands in for the operator cookie session.
 *
 * Like the API key allowlist this is an allowlist, not a denylist: a route
 * added tomorrow under a new prefix is closed to it until someone opens it
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

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
	return prefixes.some(
		(prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

export function isOperatorApiPath(pathname: string): boolean {
	return matchesPrefix(pathname, OPERATOR_API_PATH_PREFIXES);
}
