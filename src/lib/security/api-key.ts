export const API_KEY_PREFIX: string = 'signkit_';
export const API_KEY_SECRET_BYTES: number = 32;
export const API_KEY_PATTERN: RegExp = /^signkit_[A-Za-z0-9_-]{43}$/;
export const API_KEY_DISPLAY_SECRET_CHARS: number = 8;
export const API_KEY_NAME_MAX_LENGTH: number = 200;
export const API_KEY_DEFAULT_EXPIRY_DAYS: number = 90;
export const API_KEY_MAX_EXPIRY_DAYS: number = 365;
export const API_KEY_DEFAULT_EXPIRY_MS: number = API_KEY_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
export const API_KEY_MAX_EXPIRY_MS: number = API_KEY_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export const API_KEY_SCOPES = [
	'audit:read',
	'drafts:write',
	'envelopes:read',
	'envelopes:send'
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface IssuedApiKey {
	token: string;
	tokenHash: string;
	keyPrefix: string;
}

export function isApiKeyScope(value: string): value is ApiKeyScope {
	for (const scope of API_KEY_SCOPES) {
		if (scope === value) return true;
	}
	return false;
}

export function canonicalizeApiKeyScopes(scopes: readonly string[]): readonly ApiKeyScope[] {
	if (scopes.length === 0) {
		throw new Error('API key scopes must be a nonempty unique subset');
	}
	const seen: Set<ApiKeyScope> = new Set<ApiKeyScope>();
	for (const scope of scopes) {
		if (!isApiKeyScope(scope)) {
			throw new Error('API key scopes must be a nonempty unique subset');
		}
		if (seen.has(scope)) {
			throw new Error('API key scopes must be a nonempty unique subset');
		}
		seen.add(scope);
	}
	return API_KEY_SCOPES.filter((scope: ApiKeyScope): boolean => seen.has(scope));
}

export function canonicalizeApiKeyScopesJson(scopes: readonly string[]): string {
	return JSON.stringify(canonicalizeApiKeyScopes(scopes));
}

export function validateApiKeyName(name: string): string {
	const trimmed: string = name.trim();
	if (trimmed.length < 1 || trimmed.length > API_KEY_NAME_MAX_LENGTH) {
		throw new Error('Invalid API key name');
	}
	if (trimmed.startsWith(API_KEY_PREFIX)) {
		throw new Error('Invalid API key name');
	}
	for (const char of trimmed) {
		const codePoint: number | undefined = char.codePointAt(0);
		if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
			throw new Error('Invalid API key name');
		}
	}
	return trimmed;
}

export function defaultApiKeyExpiresAt(now: Date): string {
	return new Date(now.valueOf() + API_KEY_DEFAULT_EXPIRY_MS).toISOString();
}

export function resolveApiKeyExpiresAt(now: Date, requestedExpiresAt?: string | null): string {
	if (requestedExpiresAt === null) {
		throw new Error('API keys must expire');
	}
	if (requestedExpiresAt === undefined) {
		return defaultApiKeyExpiresAt(now);
	}
	const expiresAtMs: number = Date.parse(requestedExpiresAt);
	if (!Number.isFinite(expiresAtMs)) {
		throw new Error('Invalid API key expiry');
	}
	const canonical: string = new Date(expiresAtMs).toISOString();
	if (expiresAtMs <= now.valueOf()) {
		throw new Error('API key expiry must be in the future');
	}
	if (expiresAtMs > now.valueOf() + API_KEY_MAX_EXPIRY_MS) {
		throw new Error('API key expiry must be at most 365 days');
	}
	return canonical;
}

/**
 * The exact `Authorization` header shape a SignKit API key may arrive in.
 *
 * Deliberately strict and anchored: exactly one ASCII space, the `signkit_`
 * prefix, and the full 43-character base64url secret. No lowercase `bearer`, no
 * leading or trailing whitespace, no folded values, and no other credential
 * family. The recipient capability (`skr1_`), completion access grant
 * (`skca1_`), instance invitation (`ski1_`), and deployment worker secrets all
 * fail this pattern, so presenting one of them where an API key is expected can
 * never be mistaken for an API key -- it resolves to `null` here and the caller
 * answers with the same opaque outcome as an unknown key.
 */
export const API_KEY_BEARER_PATTERN: RegExp = /^Bearer (signkit_[A-Za-z0-9_-]{43})$/;

/**
 * Extracts a structurally valid API key from an `Authorization` header value.
 *
 * Returns `null` for a missing header, any non-`Bearer` scheme, any other
 * credential family, and any malformed `signkit_` value. Callers must treat
 * every `null` the same way they treat an unknown key: one opaque response, so
 * the endpoint cannot be used to distinguish "not an API key" from "not a
 * recognized API key".
 */
export function parseBearerApiKey(header: string | null): string | null {
	if (header === null) return null;
	const match: RegExpExecArray | null = API_KEY_BEARER_PATTERN.exec(header);
	return match?.[1] ?? null;
}

/**
 * True when an `Authorization` header carries a non-empty value.
 *
 * This is the bearer-exclusivity signal: on an operator surface, presenting a
 * non-empty `Authorization` value selects bearer mode and permanently forfeits
 * any cookie session on that request, so a malformed or foreign bearer value
 * fails closed instead of silently falling back to whatever browser session
 * happened to accompany it.
 *
 * The empty case is a deliberate equivalence, not an oversight, and the
 * distinction is real: `Headers.get` returns `null` for an absent header but
 * `''` for one that is present with an empty or whitespace-only value (HTTP
 * strips surrounding whitespace), and `Headers.has` reports `true` for the
 * latter. Both are treated as "no bearer presented", because an all-empty
 * `Authorization` carries no credential at all -- so the invariant that matters,
 * that an attacker-supplied *credential* must never compose with a victim's
 * cookie, is untouched. Suppressing the cookie here would only turn a
 * credential-free request into a 401 while granting no additional protection: a
 * caller able to set headers on a cookie-bearing request can simply omit the
 * header instead.
 *
 * Header duplication does not escape this. `Headers.get` joins repeated fields
 * with `", "`, so an empty value alongside a real one yields a non-empty
 * combined value that this reports as present and that {@link parseBearerApiKey}
 * then rejects, producing the opaque failure with the cookie suppressed rather
 * than a usable credential.
 */
export function hasAuthorizationHeader(header: string | null): boolean {
	return header !== null && header.length > 0;
}

export function isApiKey(value: string): boolean {
	return API_KEY_PATTERN.test(value);
}

export function parseApiKey(value: string): string {
	if (!isApiKey(value)) {
		throw new Error('Invalid API key');
	}
	return value;
}

export async function hashApiKey(token: string): Promise<string> {
	const parsed: string = parseApiKey(token);
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(parsed)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export function apiKeyDisplayPrefix(token: string): string {
	const parsed: string = parseApiKey(token);
	return parsed.slice(0, API_KEY_PREFIX.length + API_KEY_DISPLAY_SECRET_CHARS);
}

export async function issueApiKey(): Promise<IssuedApiKey> {
	const secret: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(API_KEY_SECRET_BYTES));
	crypto.getRandomValues(secret);
	const token: string = `${API_KEY_PREFIX}${base64UrlEncode(secret)}`;
	return {
		token,
		tokenHash: await hashApiKey(token),
		keyPrefix: apiKeyDisplayPrefix(token)
	};
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
