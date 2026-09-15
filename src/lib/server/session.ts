import { env } from '$env/dynamic/private';
import { AesGcmSealingKeyring, decodeBase64SealingKey } from '$lib/security/sealing-keyring';
import type { VerifiedPrincipal } from './d6e-auth';

export interface Session {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number;
	principal: VerifiedPrincipal;
}

export const SESSION_COOKIE = 'signkit_session';
export const ORGANIZATION_COOKIE = 'signkit_organization';
export const SESSION_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	secure: true,
	maxAge: 60 * 60 * 24 * 30
} as const;

/** Result of successfully opening a session cookie. */
export interface UnsealedSession {
	session: Session;
	/**
	 * Present when the cookie was not already sealed under the active key --
	 * a legacy (pre-keyring) cookie, or one still sealed under the previous
	 * key during rotation. Callers should overwrite the session cookie with
	 * this value so the cookie migrates onto the active key the next time it
	 * is used, without forcing every operator to sign in again on rotation.
	 */
	resealedCookie: string | null;
}

const IV_BYTES: number = 12;
const TAG_BYTES: number = 16;
const KEY_ID_HEX_LENGTH: number = 16;
// Bounds attacker-supplied cookie values before any base64/AEAD work runs.
// Far larger than any real operator session payload (access/refresh tokens
// plus a small principal), small enough to reject deliberately oversized
// values cheaply.
const MAX_COOKIE_LENGTH: number = 16_384;
const AAD: Uint8Array<ArrayBuffer> = utf8('signkit:operator-session-cookie:v1');
const HKDF_SALT: Uint8Array<ArrayBuffer> = utf8('signkit:session-key-derivation:v1');
const HKDF_INFO: Uint8Array<ArrayBuffer> = utf8('signkit:operator-session-key:v1');
const ENV_VAR_NAME: string = 'SESSION_ENCRYPTION_KEY';

/**
 * Cookie envelope is `base64url(keyId(16 hex ascii) | iv(12) | ciphertext+tag)`,
 * the same shape as the recipient-session and completion-token sealers.
 * Opening is fail-closed by explicit key ID -- active or previous
 * HKDF-derived operator subkey, nothing else. Additional authenticated data
 * carries a fixed operator-session purpose tag so ciphertext sealed for a
 * different purpose (recipient session, delivery capability, completion
 * token) sharing the same master key can never be reinterpreted as an
 * operator session, and vice versa.
 */
export async function seal(session: Session): Promise<string> {
	const keyring: AesGcmSealingKeyring = await operatorSessionKeyring();
	const plaintext: Uint8Array<ArrayBuffer> = utf8(JSON.stringify(session));
	const sealed = await keyring.sealWithActive(plaintext, AAD);
	const cookie: string = encodeCookie(sealed.keyId, sealed.iv, sealed.ciphertext);
	if (cookie.length > MAX_COOKIE_LENGTH) {
		throw new Error('Session cookie exceeds the maximum length');
	}
	return cookie;
}

export async function unseal(cookie: string): Promise<UnsealedSession | null> {
	if (cookie.length === 0 || cookie.length > MAX_COOKIE_LENGTH) return null;
	// Fail closed on structurally invalid input before touching key
	// configuration: a garbage cookie resolves to "no session" even when the
	// server is misconfigured, while a structurally well-formed cookie
	// surfaces configuration failures loudly instead of silently logging the
	// operator out.
	if (isCurrentFormatCandidate(cookie)) {
		const keyring: AesGcmSealingKeyring = await operatorSessionKeyring();

		const current = await tryOpenCurrentFormat(cookie, keyring);
		if (current !== null) {
			const resealedCookie: string | null = (await keyring.isActiveKeyId(current.keyId))
				? null
				: await reseal(current.session, keyring);
			return { session: current.session, resealedCookie };
		}
	}

	const legacy = await tryOpenLegacyFormat(cookie);
	if (legacy !== null) {
		const keyring: AesGcmSealingKeyring = await operatorSessionKeyring();
		return { session: legacy, resealedCookie: await reseal(legacy, keyring) };
	}

	return null;
}

export function isExpiring(session: Session, now = Math.floor(Date.now() / 1000)): boolean {
	return session.expiresAt - 60 <= now;
}

async function reseal(session: Session, keyring: AesGcmSealingKeyring): Promise<string> {
	const plaintext: Uint8Array<ArrayBuffer> = utf8(JSON.stringify(session));
	const sealed = await keyring.sealWithActive(plaintext, AAD);
	return encodeCookie(sealed.keyId, sealed.iv, sealed.ciphertext);
}

/**
 * Structural pre-check for the current cookie envelope
 * (`base64url(keyId(16 hex ascii) | iv(12) | ciphertext+tag)`), without
 * touching key configuration. Lets `unseal` fail closed on garbage input
 * even when the server is misconfigured, while well-formed cookies still
 * surface configuration failures loudly.
 */
function isCurrentFormatCandidate(cookie: string): boolean {
	let combined: Uint8Array<ArrayBuffer>;
	try {
		combined = base64UrlDecode(cookie);
	} catch {
		return false;
	}
	if (combined.byteLength <= KEY_ID_HEX_LENGTH + IV_BYTES + TAG_BYTES) return false;
	const keyId: string = new TextDecoder('ascii').decode(combined.slice(0, KEY_ID_HEX_LENGTH));
	return /^[0-9a-f]{16}$/.test(keyId);
}

async function tryOpenCurrentFormat(
	cookie: string,
	keyring: AesGcmSealingKeyring
): Promise<{ session: Session; keyId: string } | null> {
	let combined: Uint8Array<ArrayBuffer>;
	try {
		combined = base64UrlDecode(cookie);
	} catch {
		return null;
	}
	if (combined.byteLength <= KEY_ID_HEX_LENGTH + IV_BYTES + TAG_BYTES) return null;

	const keyId: string = new TextDecoder('ascii').decode(combined.slice(0, KEY_ID_HEX_LENGTH));
	if (!/^[0-9a-f]{16}$/.test(keyId)) return null;
	if (!(await keyring.isKnownKeyId(keyId))) return null;

	const iv: Uint8Array<ArrayBuffer> = combined.slice(
		KEY_ID_HEX_LENGTH,
		KEY_ID_HEX_LENGTH + IV_BYTES
	);
	const ciphertext: Uint8Array<ArrayBuffer> = combined.slice(KEY_ID_HEX_LENGTH + IV_BYTES);
	try {
		const plaintext: Uint8Array = await keyring.openWithKeyId(keyId, iv, ciphertext, AAD);
		const session: Session | null = parseSession(plaintext);
		return session === null ? null : { session, keyId };
	} catch {
		return null;
	}
}

/**
 * Reads the pre-keyring cookie shape (`base64(iv(12) | ciphertext+tag)`,
 * plain `SESSION_ENCRYPTION_KEY`, no AAD, no key ID) so existing operator
 * sessions survive this upgrade instead of being force-logged-out. Only
 * reached once the current-format open above has already failed, and the
 * cookie was already length-bounded before either path ran. Every
 * successful legacy open is resealed onto the active keyring format by the
 * caller, so this path is self-retiring as sessions get used.
 */
async function tryOpenLegacyFormat(cookie: string): Promise<Session | null> {
	const encoded: string | undefined = env.SESSION_ENCRYPTION_KEY;
	if (!encoded) return null;
	let legacyKey: CryptoKey;
	try {
		const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
		if (bytes.length !== 32) return null;
		legacyKey = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
	} catch {
		return null;
	}
	let combined: Uint8Array<ArrayBuffer>;
	try {
		combined = Uint8Array.from(atob(cookie), (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
	if (combined.byteLength <= IV_BYTES + TAG_BYTES) return null;
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: combined.slice(0, IV_BYTES) },
			legacyKey,
			combined.slice(IV_BYTES)
		);
		return parseSession(new Uint8Array(plaintext));
	} catch {
		return null;
	}
}

function parseSession(plaintext: Uint8Array): Session | null {
	try {
		const session = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
		) as Session;
		return session.principal?.subject && session.accessToken ? session : null;
	} catch {
		return null;
	}
}

async function operatorSessionKeyring(): Promise<AesGcmSealingKeyring> {
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

function encodeCookie(
	keyId: string,
	iv: Uint8Array<ArrayBuffer>,
	ciphertext: Uint8Array<ArrayBuffer>
): string {
	const keyIdBytes: Uint8Array<ArrayBuffer> = utf8(keyId);
	if (keyIdBytes.byteLength !== KEY_ID_HEX_LENGTH) {
		throw new Error('Unexpected sealing key ID length');
	}
	const combined: Uint8Array<ArrayBuffer> = new Uint8Array(
		new ArrayBuffer(keyIdBytes.byteLength + iv.byteLength + ciphertext.byteLength)
	);
	combined.set(keyIdBytes, 0);
	combined.set(iv, keyIdBytes.byteLength);
	combined.set(ciphertext, keyIdBytes.byteLength + iv.byteLength);
	return base64UrlEncode(combined);
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid session cookie encoding');
	const padding: string = '='.repeat((4 - (encoded.length % 4)) % 4);
	const base64: string = encoded.replaceAll('-', '+').replaceAll('_', '/') + padding;
	const binary: string = atob(base64);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
	const encoded: Uint8Array = new TextEncoder().encode(value);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(encoded.byteLength));
	bytes.set(encoded);
	return bytes;
}
