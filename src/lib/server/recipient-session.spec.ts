import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	RECIPIENT_SESSION_COOKIE_PREFIX,
	recipientSessionCookieName,
	sealRecipientSession,
	unsealRecipientSession
} from './recipient-session';
import { seal, unseal } from './session';

const token: string = `skr1_${'A'.repeat(43)}`;
const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const otherEnvelopeId: string = '01910000-0000-7000-8000-000000000011';

beforeEach((): void => {
	privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('recipient session sealing', () => {
	it('derives an envelope-scoped cookie name only after UUIDv7 validation', () => {
		expect(recipientSessionCookieName(envelopeId)).toBe(
			`${RECIPIENT_SESSION_COOKIE_PREFIX}${envelopeId}`
		);
		expect(recipientSessionCookieName('not-a-uuid')).toBeNull();
		expect(recipientSessionCookieName('00000000-0000-4000-8000-000000000001')).toBeNull();
		expect(recipientSessionCookieName(otherEnvelopeId)).not.toBe(
			recipientSessionCookieName(envelopeId)
		);
	});

	it('round-trips a capability with randomized, cookie-safe ciphertext', async () => {
		const first: string = await sealRecipientSession(token, envelopeId);
		const second: string = await sealRecipientSession(token, envelopeId);

		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		await expect(unsealRecipientSession(first, envelopeId)).resolves.toBe(token);
		await expect(unsealRecipientSession(second, envelopeId)).resolves.toBe(token);
	});

	it('fails closed when the envelope ID used to unseal does not match the seal', async () => {
		const sealed: string = await sealRecipientSession(token, envelopeId);
		await expect(unsealRecipientSession(sealed, otherEnvelopeId)).resolves.toBeNull();
		await expect(unsealRecipientSession(sealed, 'not-a-uuid')).resolves.toBeNull();
	});

	it('rejects sealing against a non-UUIDv7 envelope ID', async () => {
		await expect(sealRecipientSession(token, 'env-1')).rejects.toThrow(
			/Invalid recipient session envelope ID/
		);
	});

	it('fails closed for tampering, malformed data, oversized input, and key changes', async () => {
		const sealed: string = await sealRecipientSession(token, envelopeId);
		const tampered: string = `${sealed[0] === 'A' ? 'B' : 'A'}${sealed.slice(1)}`;

		await expect(unsealRecipientSession(tampered, envelopeId)).resolves.toBeNull();
		await expect(unsealRecipientSession('not+base64', envelopeId)).resolves.toBeNull();
		await expect(unsealRecipientSession('A'.repeat(400), envelopeId)).resolves.toBeNull();
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
		await expect(unsealRecipientSession(sealed, envelopeId)).resolves.toBeNull();
	});

	it('rejects malformed capabilities and invalid key configuration', async () => {
		await expect(sealRecipientSession('malformed', envelopeId)).rejects.toThrow(
			/Invalid recipient capability/
		);
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(31, 7).toString('base64');
		await expect(sealRecipientSession(token, envelopeId)).rejects.toThrow(
			/must encode exactly 32 bytes/
		);
	});

	it('propagates key configuration failures for otherwise well-formed cookies', async () => {
		const sealed: string = await sealRecipientSession(token, envelopeId);
		privateEnv.SESSION_ENCRYPTION_KEY = undefined;
		await expect(unsealRecipientSession(sealed, envelopeId)).rejects.toThrow(/is not set/);
	});

	it('cannot interchange recipient and operator session ciphertexts', async () => {
		const recipientCookie: string = await sealRecipientSession(token, envelopeId);
		const operatorCookie: string = await seal({
			accessToken: 'operator-access',
			refreshToken: null,
			expiresAt: 1_800_000_000,
			principal: { subject: 'user-1', email: 'user@example.com', name: 'User' }
		});

		await expect(unseal(recipientCookie)).resolves.toBeNull();
		await expect(unsealRecipientSession(operatorCookie, envelopeId)).resolves.toBeNull();
	});

	it('opens a cookie sealed under the previous key once the active key rotates', async () => {
		const sealedUnderOldActive: string = await sealRecipientSession(token, envelopeId);

		const rotatedKey: string = Buffer.alloc(32, 9).toString('base64');
		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = privateEnv.SESSION_ENCRYPTION_KEY;
		privateEnv.SESSION_ENCRYPTION_KEY = rotatedKey;

		await expect(unsealRecipientSession(sealedUnderOldActive, envelopeId)).resolves.toBe(token);

		// A fresh seal after rotation overwrites with the active key so the
		// cookie migrates off the retiring key on the next successful write.
		const sealedUnderNewActive: string = await sealRecipientSession(token, envelopeId);
		expect(sealedUnderNewActive).not.toBe(sealedUnderOldActive);
		await expect(unsealRecipientSession(sealedUnderNewActive, envelopeId)).resolves.toBe(token);
	});

	it('fails closed once a key is retired outside the active/previous window', async () => {
		const sealedUnderRetiredKey: string = await sealRecipientSession(token, envelopeId);

		// Two rotations later: the key that sealed this cookie is neither
		// active nor previous, so opening it must fail closed, not silently
		// try an unrelated key.
		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(32, 9).toString('base64');
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString('base64');

		await expect(unsealRecipientSession(sealedUnderRetiredKey, envelopeId)).resolves.toBeNull();
	});
});
