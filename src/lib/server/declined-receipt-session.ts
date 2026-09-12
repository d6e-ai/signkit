import { env } from '$env/dynamic/private';

export interface DeclinedReceiptSessionLocator {
	version: 1;
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	declinedAt: string;
	expiresAt: string;
}

export const DECLINED_RECEIPT_COOKIE: string = 'signkit_declined_receipt';
export const DECLINED_RECEIPT_COOKIE_PATH: string = '/';
export const DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS: number = 60 * 60 * 24 * 30;
export const DECLINED_RECEIPT_COOKIE_MAX_LENGTH: number = 1024;

export const DECLINED_RECEIPT_COOKIE_OPTIONS = {
	path: DECLINED_RECEIPT_COOKIE_PATH,
	httpOnly: true,
	sameSite: 'lax',
	secure: true,
	maxAge: DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS
} as const;

const ALGORITHM: string = 'AES-GCM';
const IV_BYTES: number = 12;
const TAG_BYTES: number = 16;
const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN: RegExp = /^[\x21-\x7e]{1,200}$/;
const SHA256_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/;
const LOCATOR_KEYS: readonly string[] = [
	'capabilityHash',
	'declinedAt',
	'envelopeId',
	'expiresAt',
	'idempotencyKey',
	'organizationId',
	'recipientId',
	'version'
];
const AAD: Uint8Array<ArrayBuffer> = utf8('signkit:declined-receipt-cookie:v1');
const HKDF_SALT: Uint8Array<ArrayBuffer> = utf8('signkit:session-key-derivation:v1');
const HKDF_INFO: Uint8Array<ArrayBuffer> = utf8('signkit:declined-receipt-key:v1');

export async function sealDeclinedReceiptSession(
	locator: DeclinedReceiptSessionLocator
): Promise<string> {
	if (!isDeclinedReceiptSessionLocator(locator))
		throw new Error('Invalid declined receipt locator');

	const iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(
		new Uint8Array(new ArrayBuffer(IV_BYTES))
	);
	const plaintext: Uint8Array<ArrayBuffer> = utf8(JSON.stringify(locator));
	const ciphertext: ArrayBuffer = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv, additionalData: AAD },
		await declinedReceiptKey(),
		plaintext
	);
	const combined: Uint8Array<ArrayBuffer> = new Uint8Array(
		new ArrayBuffer(iv.byteLength + ciphertext.byteLength)
	);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.byteLength);

	const cookie: string = base64UrlEncode(combined);
	if (cookie.length > DECLINED_RECEIPT_COOKIE_MAX_LENGTH)
		throw new Error('Declined receipt cookie exceeds the maximum length');
	return cookie;
}

export async function unsealDeclinedReceiptSession(
	cookie: string
): Promise<DeclinedReceiptSessionLocator | null> {
	if (cookie.length === 0 || cookie.length > DECLINED_RECEIPT_COOKIE_MAX_LENGTH) return null;

	let combined: Uint8Array<ArrayBuffer>;
	try {
		combined = base64UrlDecode(cookie);
		if (combined.byteLength <= IV_BYTES + TAG_BYTES) return null;
	} catch {
		return null;
	}

	const key: CryptoKey = await declinedReceiptKey();
	try {
		const plaintext: ArrayBuffer = await crypto.subtle.decrypt(
			{
				name: ALGORITHM,
				iv: combined.slice(0, IV_BYTES),
				additionalData: AAD
			},
			key,
			combined.slice(IV_BYTES)
		);
		const decoded: string = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		const candidate: unknown = JSON.parse(decoded);
		return isDeclinedReceiptSessionLocator(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

export function isDeclinedReceiptExpired(
	locator: DeclinedReceiptSessionLocator,
	now: Date = new Date()
): boolean {
	return Date.parse(locator.expiresAt) <= now.valueOf();
}

export function isDeclinedReceiptSessionLocator(
	value: unknown
): value is DeclinedReceiptSessionLocator {
	if (!isRecord(value)) return false;
	const keys: string[] = Object.keys(value).sort();
	if (keys.length !== LOCATOR_KEYS.length) return false;
	for (let index: number = 0; index < LOCATOR_KEYS.length; index += 1) {
		if (keys[index] !== LOCATOR_KEYS[index]) return false;
	}

	if (value.version !== 1) return false;
	if (!isUuid(value.organizationId)) return false;
	if (!isUuid(value.envelopeId)) return false;
	if (!isUuid(value.recipientId)) return false;
	if (typeof value.idempotencyKey !== 'string') return false;
	if (!IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)) return false;
	if (typeof value.capabilityHash !== 'string') return false;
	if (!SHA256_HEX_PATTERN.test(value.capabilityHash)) return false;
	if (typeof value.declinedAt !== 'string' || !isCanonicalIsoTimestamp(value.declinedAt))
		return false;
	if (typeof value.expiresAt !== 'string' || !isCanonicalIsoTimestamp(value.expiresAt))
		return false;
	return Date.parse(value.expiresAt) > Date.parse(value.declinedAt);
}

async function declinedReceiptKey(): Promise<CryptoKey> {
	const encoded: string | undefined = env.SESSION_ENCRYPTION_KEY;
	if (encoded === undefined || encoded.trim().length === 0)
		throw new Error('SESSION_ENCRYPTION_KEY is not set');
	const bytes: Uint8Array<ArrayBuffer> = base64Decode(encoded);
	if (bytes.byteLength !== 32)
		throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes encoded as base64');
	const masterKey: CryptoKey = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, [
		'deriveKey'
	]);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
		masterKey,
		{ name: ALGORITHM, length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCanonicalIsoTimestamp(value: string): boolean {
	const milliseconds: number = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid declined receipt encoding');
	const padding: string = '='.repeat((4 - (encoded.length % 4)) % 4);
	const base64: string = encoded.replaceAll('-', '+').replaceAll('_', '/') + padding;
	return base64Decode(base64);
}

function base64Decode(encoded: string): Uint8Array<ArrayBuffer> {
	const binary: string = atob(encoded);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index: number = 0; index < binary.length; index += 1)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
	const encoded: Uint8Array = new TextEncoder().encode(value);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(encoded.byteLength));
	bytes.set(encoded);
	return bytes;
}
