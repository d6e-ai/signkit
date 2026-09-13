import { env } from '$env/dynamic/private';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

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

export interface OrganizationMembership {
	role: 'owner' | 'admin' | 'member';
	joinedAt: string;
	organization: {
		id: string;
		slug: string;
		name: string;
		status: 'active' | 'suspended' | 'closed';
	};
}

function configuration() {
	const baseUrl = env.D6E_AUTH_BASE_URL?.replace(/\/+$/, '');
	const clientId = env.D6E_AUTH_CLIENT_ID;
	const clientSecret = env.D6E_AUTH_CLIENT_SECRET;
	if (!baseUrl || !clientId || !clientSecret) throw new Error('d6e-auth is not configured');
	return { baseUrl, clientId, clientSecret };
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
	if (!response.ok) throw new Error(`d6e-auth token exchange failed: ${response.status}`);
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
	const { payload } = await jwtVerify(token, jwks, {
		algorithms: ['RS256'],
		issuer: 'd6e-auth',
		audience: clientId
	});
	return principalFromPayload(payload);
}

export async function organizations(accessToken: string): Promise<OrganizationMembership[]> {
	const { baseUrl } = configuration();
	const response = await fetch(`${baseUrl}/api/v1/organizations`, {
		headers: { authorization: `Bearer ${accessToken}` }
	});
	if (!response.ok) throw new Error(`d6e-auth organization lookup failed: ${response.status}`);
	const body = (await response.json()) as { memberships?: unknown };
	if (!Array.isArray(body.memberships)) throw new Error('d6e-auth returned no memberships');
	return (body.memberships as OrganizationMembership[]).filter(
		(membership) => membership.organization.status === 'active'
	);
}

function principalFromPayload(payload: JWTPayload): VerifiedPrincipal {
	if (payload.type === 'refresh') throw new Error('Refresh tokens cannot authenticate requests');
	if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
		throw new Error('d6e-auth token lacks required identity claims');
	}
	return {
		subject: payload.sub,
		email: payload.email,
		name: typeof payload.name === 'string' ? payload.name : payload.email,
		emailVerified: payload.email_verified === true
	};
}
