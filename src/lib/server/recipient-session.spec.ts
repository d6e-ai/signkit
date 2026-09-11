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
		await expect(unsealRecipientSession('A'.repeat(257))).resolves.toBeNull();
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
		await expect(unsealRecipientSession(sealed)).resolves.toBeNull();
	});

	it('rejects malformed capabilities and invalid key configuration', async () => {
		await expect(sealRecipientSession('malformed')).rejects.toThrow(/Invalid recipient capability/);
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(31, 7).toString('base64');
		await expect(sealRecipientSession(token)).rejects.toThrow(/must be 32 bytes/);
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
});
