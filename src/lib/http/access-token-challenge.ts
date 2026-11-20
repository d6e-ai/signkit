/**
 * The RFC 6750 challenge for a 401 answered to a d6e-auth access-token bearer.
 *
 * Like the API key challenge it carries no `error`, realm, or scope: whether
 * the token was expired, minted for another deployment, a refresh token, or
 * malformed stays undisclosed. A console reads only "this token no longer
 * works" from it and obtains a fresh one. Cookie-session callers get no
 * challenge, exactly as before access tokens were accepted.
 */
export function accessTokenChallenge(locals: App.Locals): HeadersInit | undefined {
	return locals.accessTokenAuthentication.state === 'absent'
		? undefined
		: { 'www-authenticate': 'Bearer' };
}
