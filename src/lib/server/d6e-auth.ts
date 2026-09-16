import { env } from '$env/dynamic/private';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';

/**
 * The provider explicitly rejected a credential -- an expired, revoked, or
 * otherwise invalid refresh or access token -- as opposed to a network or
 * provider outage. Callers distinguish this from a generic `Error` to tell
 * "this session is over, sign in again" apart from "the provider might be
 * down, fail closed and let the caller retry."
 */
export class D6eAuthRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'D6eAuthRejectedError';
	}
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string | null;
	expiresIn: number;
	principal: VerifiedPrincipal;
}

export interface VerifiedPrincipal {
	subject: string;
	email: string;
	name: string;
	/**
	 * Provider-verified inbox claim. Missing or non-true `email_verified` is
	 * treated as false so sealed sessions that predate the field fail closed.
	 */
	emailVerified?: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Validates D6E_AUTH_BASE_URL as a canonical origin before it can reach any
 * token/JWKS/membership fetch: a parseable absolute URL with no userinfo,
 * query, fragment, or non-root path, scheme HTTPS except for exact loopback
 * hosts (localhost/127.0.0.1/::1), which may use HTTP -- the loopback
 * exception is itself the explicit development opt-in, mirroring the CLI's
 * `normalize_base_url` (cli/src/config.rs). Thrown messages never include
 * the configured value: this runs on every request path and must not leak
 * internal endpoint configuration into logs or error responses.
 */
function validatedBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('D6E_AUTH_BASE_URL must be a valid absolute URL');
	}
	if (url.username || url.password) {
		throw new Error('D6E_AUTH_BASE_URL must not contain credentials');
	}
	if (url.search || url.hash) {
		throw new Error('D6E_AUTH_BASE_URL must not contain a query string or fragment');
	}
	if (url.pathname !== '/' && url.pathname !== '') {
		throw new Error('D6E_AUTH_BASE_URL must not contain a path');
	}
	if (url.protocol === 'https:') {
		return url.origin;
	}
	if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
		return url.origin;
	}
	throw new Error(
		'D6E_AUTH_BASE_URL must be a canonical HTTPS origin (HTTP is only permitted for loopback hosts in development)'
	);
}

function configuration() {
	const rawBaseUrl = env.D6E_AUTH_BASE_URL;
	const clientId = env.D6E_AUTH_CLIENT_ID;
	const clientSecret = env.D6E_AUTH_CLIENT_SECRET;
	if (!rawBaseUrl || !clientId || !clientSecret) throw new Error('d6e-auth is not configured');
	return { baseUrl: validatedBaseUrl(rawBaseUrl), clientId, clientSecret };
}

export function authorizeUrl(redirectUri: string, state: string): string {
	const { baseUrl, clientId } = configuration();
	const url = new URL(`${baseUrl}/auth/login`);
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('state', state);
	return url.toString();
}

export async function exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
	return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

export async function refresh(refreshToken: string): Promise<TokenSet> {
	return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function tokenRequest(parameters: Record<string, string>): Promise<TokenSet> {
	const { baseUrl, clientId, clientSecret } = configuration();
	const response = await fetch(`${baseUrl}/api/v1/auth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...parameters, client_id: clientId, client_secret: clientSecret })
	});
	if (!response.ok) {
		// A 400 here is the OAuth2 `invalid_grant` shape: the refresh token
		// itself was rejected -- expired, revoked, or already used -- not a
		// provider outage. Every other status, including 401/403 (which point at
		// client misconfiguration rather than this session), stays a generic
		// failure so a provider or config problem never gets misread as "this
		// caller's session ended."
		if (response.status === 400) {
			throw new D6eAuthRejectedError(`d6e-auth token exchange rejected: ${response.status}`);
		}
		throw new Error(`d6e-auth token exchange failed: ${response.status}`);
	}
	const body = (await response.json()) as {
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	};
	if (typeof body.access_token !== 'string') throw new Error('d6e-auth returned no access token');
	return {
		accessToken: body.access_token,
		refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
		expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
		principal: await verifyAccessToken(body.access_token)
	};
}

export async function verifyAccessToken(token: string): Promise<VerifiedPrincipal> {
	const { baseUrl, clientId } = configuration();
	const jwks = createRemoteJWKSet(new URL(`${baseUrl}/.well-known/jwks.json`));
	try {
		const { payload } = await jwtVerify(token, jwks, {
			algorithms: ['RS256'],
			issuer: 'd6e-auth',
			audience: clientId
		});
		return principalFromPayload(payload);
	} catch (error: unknown) {
		// Only the errors that pass a verdict on this specific token -- expired,
		// malformed, wrong signature, disallowed algorithm, no matching key in an
		// otherwise-resolved JWKS, or failing issuer/audience claims -- are
		// reclassified as rejected. A JWKS fetch timeout or an unresolvable key
		// set says nothing about the token itself, so it stays a generic
		// (unavailable) failure.
		if (
			error instanceof joseErrors.JWTExpired ||
			error instanceof joseErrors.JWTClaimValidationFailed ||
			error instanceof joseErrors.JWSSignatureVerificationFailed ||
			error instanceof joseErrors.JWTInvalid ||
			error instanceof joseErrors.JWSInvalid ||
			error instanceof joseErrors.JOSEAlgNotAllowed ||
			error instanceof joseErrors.JWKSNoMatchingKey
		) {
			throw new D6eAuthRejectedError('d6e-auth access token rejected');
		}
		throw error;
	}
}

function principalFromPayload(payload: JWTPayload): VerifiedPrincipal {
	if (payload.type === 'refresh') {
		throw new D6eAuthRejectedError('Refresh tokens cannot authenticate requests');
	}
	if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
		throw new D6eAuthRejectedError('d6e-auth token lacks required identity claims');
	}
	return {
		subject: payload.sub,
		email: payload.email,
		name: typeof payload.name === 'string' ? payload.name : payload.email,
		emailVerified: payload.email_verified === true
	};
}
