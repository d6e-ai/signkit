export const WORKLOAD_KEY_PREFIX: string = 'signkit_';
export const WORKLOAD_KEY_SECRET_BYTES: number = 32;
export const WORKLOAD_KEY_PATTERN: RegExp = /^signkit_[A-Za-z0-9_-]{43}$/;
export const WORKLOAD_KEY_DISPLAY_SECRET_CHARS: number = 8;
export const WORKLOAD_KEY_NAME_MAX_LENGTH: number = 200;
export const WORKLOAD_KEY_DEFAULT_EXPIRY_DAYS: number = 90;
export const WORKLOAD_KEY_MAX_EXPIRY_DAYS: number = 365;
export const WORKLOAD_KEY_DEFAULT_EXPIRY_MS: number =
	WORKLOAD_KEY_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
export const WORKLOAD_KEY_MAX_EXPIRY_MS: number =
	WORKLOAD_KEY_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export const WORKLOAD_KEY_SCOPES = [
	'audit:read',
	'drafts:write',
	'envelopes:read',
	'envelopes:send'
] as const;

export type WorkloadKeyScope = (typeof WORKLOAD_KEY_SCOPES)[number];

export interface IssuedWorkloadKey {
	token: string;
	tokenHash: string;
	keyPrefix: string;
}

export function isWorkloadKeyScope(value: string): value is WorkloadKeyScope {
	for (const scope of WORKLOAD_KEY_SCOPES) {
		if (scope === value) return true;
	}
	return false;
}

export function canonicalizeWorkloadKeyScopes(
	scopes: readonly string[]
): readonly WorkloadKeyScope[] {
	if (scopes.length === 0) {
		throw new Error('Workload key scopes must be a nonempty unique subset');
	}
	const seen: Set<WorkloadKeyScope> = new Set<WorkloadKeyScope>();
	for (const scope of scopes) {
		if (!isWorkloadKeyScope(scope)) {
			throw new Error('Workload key scopes must be a nonempty unique subset');
		}
		if (seen.has(scope)) {
			throw new Error('Workload key scopes must be a nonempty unique subset');
		}
		seen.add(scope);
	}
	return WORKLOAD_KEY_SCOPES.filter((scope: WorkloadKeyScope): boolean => seen.has(scope));
}

export function canonicalizeWorkloadKeyScopesJson(scopes: readonly string[]): string {
	return JSON.stringify(canonicalizeWorkloadKeyScopes(scopes));
}

export function validateWorkloadKeyName(name: string): string {
	const trimmed: string = name.trim();
	if (trimmed.length < 1 || trimmed.length > WORKLOAD_KEY_NAME_MAX_LENGTH) {
		throw new Error('Invalid workload key name');
	}
	if (trimmed.startsWith(WORKLOAD_KEY_PREFIX)) {
		throw new Error('Invalid workload key name');
	}
	for (const char of trimmed) {
		const codePoint: number | undefined = char.codePointAt(0);
		if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
			throw new Error('Invalid workload key name');
		}
	}
	return trimmed;
}

export function defaultWorkloadKeyExpiresAt(now: Date): string {
	return new Date(now.valueOf() + WORKLOAD_KEY_DEFAULT_EXPIRY_MS).toISOString();
}

export function resolveWorkloadKeyExpiresAt(now: Date, requestedExpiresAt?: string | null): string {
	if (requestedExpiresAt === null) {
		throw new Error('Workload keys must expire');
	}
	if (requestedExpiresAt === undefined) {
		return defaultWorkloadKeyExpiresAt(now);
	}
	const expiresAtMs: number = Date.parse(requestedExpiresAt);
	if (!Number.isFinite(expiresAtMs)) {
		throw new Error('Invalid workload key expiry');
	}
	const canonical: string = new Date(expiresAtMs).toISOString();
	if (expiresAtMs <= now.valueOf()) {
		throw new Error('Workload key expiry must be in the future');
	}
	if (expiresAtMs > now.valueOf() + WORKLOAD_KEY_MAX_EXPIRY_MS) {
		throw new Error('Workload key expiry must be at most 365 days');
	}
	return canonical;
}

export function isWorkloadKey(value: string): boolean {
	return WORKLOAD_KEY_PATTERN.test(value);
}

export function parseWorkloadKey(value: string): string {
	if (!isWorkloadKey(value)) {
		throw new Error('Invalid workload key');
	}
	return value;
}

export async function hashWorkloadKey(token: string): Promise<string> {
	const parsed: string = parseWorkloadKey(token);
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(parsed)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export function workloadKeyDisplayPrefix(token: string): string {
	const parsed: string = parseWorkloadKey(token);
	return parsed.slice(0, WORKLOAD_KEY_PREFIX.length + WORKLOAD_KEY_DISPLAY_SECRET_CHARS);
}

export async function issueWorkloadKey(): Promise<IssuedWorkloadKey> {
	const secret: Uint8Array<ArrayBuffer> = new Uint8Array(
		new ArrayBuffer(WORKLOAD_KEY_SECRET_BYTES)
	);
	crypto.getRandomValues(secret);
	const token: string = `${WORKLOAD_KEY_PREFIX}${base64UrlEncode(secret)}`;
	return {
		token,
		tokenHash: await hashWorkloadKey(token),
		keyPrefix: workloadKeyDisplayPrefix(token)
	};
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
