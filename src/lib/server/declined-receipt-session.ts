import { env } from '$env/dynamic/private';
import { AesGcmSealingKeyring, decodeBase64SealingKey } from '$lib/security/sealing-keyring';

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

const IV_BYTES: number = 12;
const TAG_BYTES: number = 16;
const KEY_ID_HEX_LENGTH: number = 16;
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
const ENV_VAR_NAME: string = 'SESSION_ENCRYPTION_KEY';

export async function sealDeclinedReceiptSession(
	locator: DeclinedReceiptSessionLocator
): Promise<string> {
	if (!isDeclinedReceiptSessionLocator(locator))
		throw new Error('Invalid declined receipt locator');

	const keyring: AesGcmSealingKeyring = await declinedReceiptKeyring();
	const plaintext: Uint8Array<ArrayBuffer> = utf8(JSON.stringify(locator));
	const sealed = await keyring.sealWithActive(plaintext, AAD);
	const keyIdBytes: Uint8Array<ArrayBuffer> = utf8(sealed.keyId);
	if (keyIdBytes.byteLength !== KEY_ID_HEX_LENGTH)
		throw new Error('Unexpected sealing key ID length');
	const combined: Uint8Array<ArrayBuffer> = new Uint8Array(
		new ArrayBuffer(keyIdBytes.byteLength + sealed.iv.byteLength + sealed.ciphertext.byteLength)
	);
	combined.set(keyIdBytes, 0);
	combined.set(sealed.iv, keyIdBytes.byteLength);
	combined.set(sealed.ciphertext, keyIdBytes.byteLength + sealed.iv.byteLength);

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
		if (combined.byteLength <= KEY_ID_HEX_LENGTH + IV_BYTES + TAG_BYTES) return null;
	} catch {
		return null;
	}

	const keyId: string = new TextDecoder('ascii').decode(combined.slice(0, KEY_ID_HEX_LENGTH));
	const iv: Uint8Array<ArrayBuffer> = combined.slice(
		KEY_ID_HEX_LENGTH,
		KEY_ID_HEX_LENGTH + IV_BYTES
	);
	const ciphertext: Uint8Array<ArrayBuffer> = combined.slice(KEY_ID_HEX_LENGTH + IV_BYTES);
	const keyring: AesGcmSealingKeyring = await declinedReceiptKeyring();
	try {
		const plaintext: Uint8Array = await keyring.openWithKeyId(keyId, iv, ciphertext, AAD);
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

async function declinedReceiptKeyring(): Promise<AesGcmSealingKeyring> {
	const activeMaster: Uint8Array<ArrayBuffer> = decodeBase64SealingKey(
		requiredEnv(ENV_VAR_NAME, env.SESSION_ENCRYPTION_KEY),
		ENV_VAR_NAME
	);
	const previousEncoded: string | undefined = optionalEnv(env.SESSION_ENCRYPTION_KEY_PREVIOUS);
	const activeSubkey: Uint8Array<ArrayBuffer> = await deriveSubkey(activeMaster);
	const previousSubkey: Uint8Array<ArrayBuffer> | null =
		previousEncoded === undefined
			? null
			: await deriveSubkey(decodeBase64SealingKey(previousEncoded, `${ENV_VAR_NAME}_PREVIOUS`));
	return new AesGcmSealingKeyring(activeSubkey, previousSubkey);
}

async function deriveSubkey(
	masterKeyBytes: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
	const masterKey: CryptoKey = await crypto.subtle.importKey('raw', masterKeyBytes, 'HKDF', false, [
		'deriveBits'
	]);
	const derived: ArrayBuffer = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
		masterKey,
		256
	);
	return new Uint8Array(derived);
}

function requiredEnv(name: string, value: string | undefined): string {
	if (value === undefined || value.trim().length === 0) throw new Error(`${name} is not set`);
	return value;
}

function optionalEnv(value: string | undefined): string | undefined {
	if (value === undefined || value.trim().length === 0) return undefined;
	return value;
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
