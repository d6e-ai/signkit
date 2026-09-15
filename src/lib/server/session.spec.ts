import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import type { VerifiedPrincipal } from './d6e-auth';
import { sealRecipientSession } from './recipient-session';
import { isExpiring, seal, unseal, type Session } from './session';

const PRINCIPAL: VerifiedPrincipal = {
	subject: 'user-1',
	email: 'user@example.com',
	name: 'User',
	emailVerified: true
};

function session(overrides: Partial<Session> = {}): Session {
	return {
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
		principal: PRINCIPAL,
		...overrides
	};
}

/** Replicates the pre-keyring cookie format this module used to emit:
 * `base64(iv(12) | ciphertext+tag)`, encrypted directly under the raw
 * `SESSION_ENCRYPTION_KEY` bytes with no AAD, no HKDF subkey, no key ID. */
async function sealLegacy(value: Session, keyBase64: string): Promise<string> {
	const bytes = Uint8Array.from(atob(keyBase64), (character) => character.charCodeAt(0));
	const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify(value));
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);
	let binary = '';
	for (const byte of combined) binary += String.fromCharCode(byte);
	return btoa(binary);
}

beforeEach((): void => {
	privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('operator session sealing', () => {
	it('round-trips with randomized, cookie-safe ciphertext and no reseal needed', async () => {
		const original = session();
		const first = await seal(original);
		const second = await seal(original);

		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);

		const opened = await unseal(first);
		expect(opened).not.toBeNull();
		expect(opened?.session).toEqual(original);
		expect(opened?.resealedCookie).toBeNull();
	});

	it('fails closed for tampering, malformed data, and oversized input', async () => {
		const sealed = await seal(session());
		const tampered = `${sealed[0] === 'A' ? 'B' : 'A'}${sealed.slice(1)}`;

		await expect(unseal(tampered)).resolves.toBeNull();
		await expect(unseal('not+valid+base64url')).resolves.toBeNull();
		await expect(unseal('A'.repeat(20_000))).resolves.toBeNull();
		await expect(unseal('')).resolves.toBeNull();
	});

	it('rejects a cookie sealed under a key outside the active/previous window', async () => {
		const sealed = await seal(session());

		// Two rotations later: the key that sealed this cookie is neither
		// active nor previous, so opening it must fail closed.
		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(32, 8).toString('base64');
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

		await expect(unseal(sealed)).resolves.toBeNull();
	});

	it('opens and reseals a cookie sealed under the previous key once the active key rotates', async () => {
		const original = session();
		const sealedUnderOldActive = await seal(original);

		const rotatedKey = Buffer.alloc(32, 8).toString('base64');
		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = privateEnv.SESSION_ENCRYPTION_KEY;
		privateEnv.SESSION_ENCRYPTION_KEY = rotatedKey;

		const opened = await unseal(sealedUnderOldActive);
		expect(opened?.session).toEqual(original);
		expect(opened?.resealedCookie).not.toBeNull();
		expect(opened?.resealedCookie).not.toBe(sealedUnderOldActive);

		// The resealed cookie is now sealed under the new active key: opening
		// it again needs no further reseal.
		const reopened = await unseal(opened!.resealedCookie!);
		expect(reopened?.session).toEqual(original);
		expect(reopened?.resealedCookie).toBeNull();
	});

	it('migrates a legacy (pre-keyring) cookie transparently and reseals it onto the active keyring format', async () => {
		const original = session();
		const legacyCookie = await sealLegacy(original, privateEnv.SESSION_ENCRYPTION_KEY!);

		const opened = await unseal(legacyCookie);
		expect(opened?.session).toEqual(original);
		expect(opened?.resealedCookie).not.toBeNull();
		// New format is base64url with a 16-hex-char key ID prefix; the legacy
		// format was plain base64 with no such structure.
		expect(opened?.resealedCookie).toMatch(/^[A-Za-z0-9_-]+$/);

		const reopened = await unseal(opened!.resealedCookie!);
		expect(reopened?.session).toEqual(original);
		expect(reopened?.resealedCookie).toBeNull();
	});

	it('fails closed for a legacy-format cookie sealed under a different key', async () => {
		const legacyCookie = await sealLegacy(session(), Buffer.alloc(32, 3).toString('base64'));
		await expect(unseal(legacyCookie)).resolves.toBeNull();
	});

	it('cannot interchange operator and recipient session ciphertexts (purpose separation)', async () => {
		const token = `skr1_${'A'.repeat(43)}`;
		const envelopeId = '01910000-0000-7000-8000-000000000001';
		const recipientCookie = await sealRecipientSession(token, envelopeId);

		await expect(unseal(recipientCookie)).resolves.toBeNull();
	});

	it('rejects a session payload missing required identity fields', async () => {
		const sealed = await seal(session({ accessToken: '' }));
		await expect(unseal(sealed)).resolves.toBeNull();
	});

	it('propagates key configuration failures for otherwise well-formed cookies', async () => {
		const sealed = await seal(session());
		privateEnv.SESSION_ENCRYPTION_KEY = undefined;
		await expect(unseal(sealed)).rejects.toThrow(/is not set/);
	});

	it('rejects malformed key configuration on seal', async () => {
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(31, 7).toString('base64');
		await expect(seal(session())).rejects.toThrow(/must encode exactly 32 bytes/);
	});
});

describe('isExpiring', () => {
	it('treats a session within 60 seconds of expiry as expiring', () => {
		const now = 1_000_000;
		expect(isExpiring(session({ expiresAt: now + 59 }), now)).toBe(true);
		expect(isExpiring(session({ expiresAt: now + 61 }), now)).toBe(false);
	});
});
