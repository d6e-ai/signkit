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
