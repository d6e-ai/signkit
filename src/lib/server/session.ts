import { env } from '$env/dynamic/private';
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
const ALGORITHM = 'AES-GCM';
const IV_BYTES = 12;

async function sessionKey(): Promise<CryptoKey> {
	const encoded = env.SESSION_ENCRYPTION_KEY;
	if (!encoded) throw new Error('SESSION_ENCRYPTION_KEY is not set');
	const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
	if (bytes.length !== 32)
		throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes encoded as base64');
	return crypto.subtle.importKey('raw', bytes, ALGORITHM, false, ['encrypt', 'decrypt']);
}

export async function seal(session: Session): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const plaintext = new TextEncoder().encode(JSON.stringify(session));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		await sessionKey(),
		plaintext
	);
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return bytesToBase64(combined);
}

export async function unseal(cookie: string): Promise<Session | null> {
	try {
		const combined = Uint8Array.from(atob(cookie), (character) => character.charCodeAt(0));
		const plaintext = await crypto.subtle.decrypt(
			{ name: ALGORITHM, iv: combined.slice(0, IV_BYTES) },
			await sessionKey(),
			combined.slice(IV_BYTES)
		);
		const session = JSON.parse(new TextDecoder().decode(plaintext)) as Session;
		return session.principal?.subject && session.accessToken ? session : null;
	} catch {
		return null;
	}
}

export function isExpiring(session: Session, now = Math.floor(Date.now() / 1000)): boolean {
	return session.expiresAt - 60 <= now;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}
