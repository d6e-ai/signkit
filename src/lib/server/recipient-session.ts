import { env } from '$env/dynamic/private';
import { isRecipientCapability } from '$lib/security/recipient-capability';

export const RECIPIENT_SESSION_COOKIE: string = 'signkit_recipient';
export const RECIPIENT_SESSION_COOKIE_PATH: string = '/';
export const RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS: number = 60 * 60 * 24 * 30;

export const RECIPIENT_SESSION_COOKIE_OPTIONS = {
	path: RECIPIENT_SESSION_COOKIE_PATH,
	httpOnly: true,
	sameSite: 'lax',
	secure: true
} as const;

const ALGORITHM: string = 'AES-GCM';
const IV_BYTES: number = 12;
const TAG_BYTES: number = 16;
const MAX_COOKIE_LENGTH: number = 256;
const AAD: Uint8Array<ArrayBuffer> = utf8('signkit:recipient-session-cookie:v1');
const HKDF_SALT: Uint8Array<ArrayBuffer> = utf8('signkit:session-key-derivation:v1');
const HKDF_INFO: Uint8Array<ArrayBuffer> = utf8('signkit:recipient-session-key:v1');

export async function sealRecipientSession(token: string): Promise<string> {
	if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
	const iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(
		new Uint8Array(new ArrayBuffer(IV_BYTES))
	);
	const plaintext: Uint8Array<ArrayBuffer> = utf8(token);
	const ciphertext: ArrayBuffer = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv, additionalData: AAD },
		await recipientSessionKey(),
		plaintext
	);
	const combined: Uint8Array<ArrayBuffer> = new Uint8Array(
		new ArrayBuffer(iv.byteLength + ciphertext.byteLength)
	);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.byteLength);
	return base64UrlEncode(combined);
}

export async function unsealRecipientSession(cookie: string): Promise<string | null> {
	if (cookie.length === 0 || cookie.length > MAX_COOKIE_LENGTH) return null;
	let combined: Uint8Array<ArrayBuffer>;
	try {
		combined = base64UrlDecode(cookie);
		if (combined.byteLength <= IV_BYTES + TAG_BYTES) return null;
	} catch {
		return null;
	}

	const key: CryptoKey = await recipientSessionKey();
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
		const token: string = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		return isRecipientCapability(token) ? token : null;
	} catch {
		return null;
	}
}

async function recipientSessionKey(): Promise<CryptoKey> {
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

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid recipient session encoding');
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
