import { API_KEY_PREFIX } from './api-key';

/**
 * Upper bound on a presented d6e-auth access token. A compact RS256 JWS with
 * the identity claims SignKit reads is well under 2 KiB; the bound only keeps
 * pathological header values away from signature verification.
 */
export const ACCESS_TOKEN_BEARER_MAX_LENGTH: number = 8192;

/**
 * The exact `Authorization` header shape a d6e-auth access token may arrive in:
 * `Bearer ` (exactly one ASCII space, the same case-sensitive scheme the API key
 * parser accepts) followed by a compact JWS -- three base64url segments
 * separated by dots, with a non-empty signature.
 *
 * None of SignKit's own opaque credential families contains a dot, so a
 * recipient capability (`skr1_`), completion grant (`skca1_`), invitation token
 * (`ski1_`), worker secret, or API key can never match this shape and is left
 * to the handling it had before access tokens were accepted.
 */
export const ACCESS_TOKEN_BEARER_PATTERN: RegExp =
	/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * Extracts a structurally plausible d6e-auth access token from an
 * `Authorization` header value.
 *
 * Returns `null` for a missing header, any other scheme, an oversized value, a
 * value that is not a compact JWS, and anything starting with `signkit_` --
 * that prefix always belongs to the API key family, whose own parser decides
 * what a malformed key means. A non-null result is only a candidate: it carries
 * no authority until `verifyBearerAccessToken` accepts it.
 */
export function parseBearerAccessToken(header: string | null): string | null {
	if (header === null || header.length > ACCESS_TOKEN_BEARER_MAX_LENGTH + 'Bearer '.length) {
		return null;
	}
	const match: RegExpExecArray | null = ACCESS_TOKEN_BEARER_PATTERN.exec(header);
	const token: string | undefined = match?.[1];
	if (token === undefined || token.startsWith(API_KEY_PREFIX)) return null;
	return token;
}
