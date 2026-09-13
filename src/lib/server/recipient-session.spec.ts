import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { sealRecipientSession, unsealRecipientSession } from './recipient-session';
import { seal, unseal } from './session';

const token: string = `skr1_${'A'.repeat(43)}`;

beforeEach((): void => {
	privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('recipient session sealing', () => {
	it('round-trips a capability with randomized, cookie-safe ciphertext', async () => {
		const first: string = await sealRecipientSession(token);
		const second: string = await sealRecipientSession(token);

		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		await expect(unsealRecipientSession(first)).resolves.toBe(token);
		await expect(unsealRecipientSession(second)).resolves.toBe(token);
	});

	it('fails closed for tampering, malformed data, oversized input, and key changes', async () => {
		const sealed: string = await sealRecipientSession(token);
		const tampered: string = `${sealed[0] === 'A' ? 'B' : 'A'}${sealed.slice(1)}`;

		await expect(unsealRecipientSession(tampered)).resolves.toBeNull();
		await expect(unsealRecipientSession('not+base64')).resolves.toBeNull();
		await expect(unsealRecipientSession('A'.repeat(400))).resolves.toBeNull();
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
		await expect(unsealRecipientSession(sealed)).resolves.toBeNull();
	});

	it('rejects malformed capabilities and invalid key configuration', async () => {
		await expect(sealRecipientSession('malformed')).rejects.toThrow(/Invalid recipient capability/);
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(31, 7).toString('base64');
		await expect(sealRecipientSession(token)).rejects.toThrow(/must encode exactly 32 bytes/);
	});

	it('propagates key configuration failures for otherwise well-formed cookies', async () => {
		const sealed: string = await sealRecipientSession(token);
		privateEnv.SESSION_ENCRYPTION_KEY = undefined;
		await expect(unsealRecipientSession(sealed)).rejects.toThrow(/is not set/);
	});

	it('cannot interchange recipient and operator session ciphertexts', async () => {
		const recipientCookie: string = await sealRecipientSession(token);
		const operatorCookie: string = await seal({
			accessToken: 'operator-access',
			refreshToken: null,
			expiresAt: 1_800_000_000,
			principal: { subject: 'user-1', email: 'user@example.com', name: 'User' }
		});

		await expect(unseal(recipientCookie)).resolves.toBeNull();
		await expect(unsealRecipientSession(operatorCookie)).resolves.toBeNull();
	});

	it('opens a cookie sealed under the previous key once the active key rotates', async () => {
		const sealedUnderOldActive: string = await sealRecipientSession(token);

		const rotatedKey: string = Buffer.alloc(32, 9).toString('base64');
		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = privateEnv.SESSION_ENCRYPTION_KEY;
		privateEnv.SESSION_ENCRYPTION_KEY = rotatedKey;

		await expect(unsealRecipientSession(sealedUnderOldActive)).resolves.toBe(token);

		// A fresh seal after rotation overwrites with the active key so the
		// cookie migrates off the retiring key on the next successful write.
		const sealedUnderNewActive: string = await sealRecipientSession(token);
		expect(sealedUnderNewActive).not.toBe(sealedUnderOldActive);
		await expect(unsealRecipientSession(sealedUnderNewActive)).resolves.toBe(token);
	});

	it('fails closed once a key is retired outside the active/previous window', async () => {
		const sealedUnderRetiredKey: string = await sealRecipientSession(token);

		// Two rotations later: the key that sealed this cookie is neither
		// active nor previous, so opening it must fail closed, not silently
		// try an unrelated key.
		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(32, 9).toString('base64');
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString('base64');

		await expect(unsealRecipientSession(sealedUnderRetiredKey)).resolves.toBeNull();
	});
});
