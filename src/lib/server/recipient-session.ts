import { env } from '$env/dynamic/private';
import { isUuidV7 } from '$lib/ids/uuid-v7';
import { isRecipientCapability } from '$lib/security/recipient-capability';
import { AesGcmSealingKeyring, decodeBase64SealingKey } from '$lib/security/sealing-keyring';

export const RECIPIENT_SESSION_COOKIE_PREFIX: string = 'signkit_recipient_';
// The exchange is under /s while localized review pages are under
// /{locale}/sign/{envelopeId}, so one host-only cookie needs the shared root path.
export const RECIPIENT_SESSION_COOKIE_PATH: string = '/';
export const RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS: number = 60 * 60 * 24 * 30;

export const RECIPIENT_SESSION_COOKIE_OPTIONS = {
	path: RECIPIENT_SESSION_COOKIE_PATH,
	httpOnly: true,
	sameSite: 'lax',
	secure: true
} as const;

const IV_BYTES: number = 12;
const TAG_BYTES: number = 16;
const MAX_COOKIE_LENGTH: number = 300;
const KEY_ID_HEX_LENGTH: number = 16;
const AAD_PREFIX: string = 'signkit:recipient-session-cookie:v1:';
const HKDF_SALT: Uint8Array<ArrayBuffer> = utf8('signkit:session-key-derivation:v1');
const HKDF_INFO: Uint8Array<ArrayBuffer> = utf8('signkit:recipient-session-key:v1');
const ENV_VAR_NAME: string = 'SESSION_ENCRYPTION_KEY';

export function recipientSessionCookieName(envelopeId: string): string | null {
	if (!isUuidV7(envelopeId)) return null;
	return `${RECIPIENT_SESSION_COOKIE_PREFIX}${envelopeId}`;
}

export function readRecipientSessionCookie(
	cookies: { get(name: string): string | undefined },
	envelopeId: string
): string | undefined {
	const name: string | null = recipientSessionCookieName(envelopeId);
	if (name === null) return undefined;
	return cookies.get(name);
}

export function deleteRecipientSessionCookie(
	cookies: { delete(name: string, opts: { path: string }): void },
	envelopeId: string
): void {
	const name: string | null = recipientSessionCookieName(envelopeId);
	if (name === null) return;
	cookies.delete(name, { path: RECIPIENT_SESSION_COOKIE_PATH });
}

/**
 * Cookie envelope is `base64url(keyId(16 hex ascii) | iv(12) | ciphertext+tag)`.
 * The key ID travels with the ciphertext so opening is fail-closed by
 * explicit ID — active or previous HKDF-derived subkey, nothing else —
 * exactly like the delivery capability and completion token sealers.
 * Additional authenticated data binds the ciphertext to this envelope ID
 * so a cookie value cannot be copied onto another envelope's cookie name.
 */
export async function sealRecipientSession(token: string, envelopeId: string): Promise<string> {
	if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
	const aad: Uint8Array<ArrayBuffer> | null = recipientSessionAad(envelopeId);
	if (aad === null) throw new Error('Invalid recipient session envelope ID');
	const keyring: AesGcmSealingKeyring = await recipientSessionKeyring();
	const plaintext: Uint8Array<ArrayBuffer> = utf8(token);
	const sealed = await keyring.sealWithActive(plaintext, aad);
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
	if (cookie.length > MAX_COOKIE_LENGTH) {
		throw new Error('Recipient session cookie exceeds the maximum length');
	}
	return cookie;
}

export async function unsealRecipientSession(
	cookie: string,
	envelopeId: string
): Promise<string | null> {
	const aad: Uint8Array<ArrayBuffer> | null = recipientSessionAad(envelopeId);
	if (aad === null) return null;
	if (cookie.length === 0 || cookie.length > MAX_COOKIE_LENGTH) return null;
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
	const keyring: AesGcmSealingKeyring = await recipientSessionKeyring();
	try {
		const plaintext: Uint8Array = await keyring.openWithKeyId(keyId, iv, ciphertext, aad);
		const token: string = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		return isRecipientCapability(token) ? token : null;
	} catch {
		return null;
	}
}

function recipientSessionAad(envelopeId: string): Uint8Array<ArrayBuffer> | null {
	if (!isUuidV7(envelopeId)) return null;
	return utf8(`${AAD_PREFIX}${envelopeId}`);
}

async function recipientSessionKeyring(): Promise<AesGcmSealingKeyring> {
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
