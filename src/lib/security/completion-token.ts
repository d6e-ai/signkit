export const COMPLETION_TOKEN_PREFIX: string = 'skca1_';
export const COMPLETION_TOKEN_BYTES: number = 32;
export const COMPLETION_TOKEN_PATTERN: RegExp = /^skca1_[A-Za-z0-9_-]{43}$/;
export const COMPLETION_ACCESS_EXPIRY_DAYS: number = 30;
export const COMPLETION_ACCESS_EXPIRY_MS: number =
	COMPLETION_ACCESS_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export interface IssuedCompletionToken {
	token: string;
	tokenHash: string;
}

export function isCompletionToken(value: string): boolean {
	return COMPLETION_TOKEN_PATTERN.test(value);
}

export async function hashCompletionToken(token: string): Promise<string> {
	if (!isCompletionToken(token)) {
		throw new Error('Invalid completion token');
	}
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export async function issueCompletionToken(): Promise<IssuedCompletionToken> {
	const secret: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(COMPLETION_TOKEN_BYTES));
	crypto.getRandomValues(secret);
	const token: string = `${COMPLETION_TOKEN_PREFIX}${base64UrlEncode(secret)}`;
	return {
		token,
		tokenHash: await hashCompletionToken(token)
	};
}

export function completionAccessPath(token: string): `/c/${string}` {
	if (!isCompletionToken(token)) {
		throw new Error('Invalid completion token');
	}
	return `/c/${token}`;
}

export type CompletionReceiptLocale = 'en' | 'ja';

/**
 * The recipient-facing receipt landing page for a completion grant, prefixed
 * for `locale` so the first click from a transactional email already renders
 * in the recipient's language -- there is no session or cookie yet to carry
 * that preference. Mirrors the `en`/`ja` URL prefixing the app's Paraglide
 * routing config applies everywhere else (base locale `en` unprefixed, `ja`
 * under `/ja`), without depending on the generated runtime module, which
 * this security-layer helper has no reason to import.
 */
export function completionReceiptPath(
	token: string,
	locale: CompletionReceiptLocale
): `/c/${string}/view` | `/ja/c/${string}/view` {
	if (!isCompletionToken(token)) {
		throw new Error('Invalid completion token');
	}
	return locale === 'ja' ? `/ja/c/${token}/view` : `/c/${token}/view`;
}

export function computeCompletionAccessExpiry(now: Date): string {
	return new Date(now.valueOf() + COMPLETION_ACCESS_EXPIRY_MS).toISOString();
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
