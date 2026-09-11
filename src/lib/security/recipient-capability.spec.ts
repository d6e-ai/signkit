import { describe, expect, it } from 'vitest';
import {
	hashRecipientCapability,
	isRecipientCapability,
	issueRecipientCapability,
	recipientSigningPath
} from './recipient-capability';

describe('recipient capabilities', () => {
	it('issues opaque 256-bit bearer tokens and stores only their hashes', async () => {
		const first = await issueRecipientCapability();
		const second = await issueRecipientCapability();

		expect(first.token).toMatch(/^skr1_[A-Za-z0-9_-]{43}$/);
		expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
		expect(first.tokenHash).toBe(await hashRecipientCapability(first.token));
		expect(first.token).not.toBe(second.token);
		expect(first.tokenHash).not.toBe(second.tokenHash);
	});

	it('rejects malformed and truncated tokens before hashing', async () => {
		expect(isRecipientCapability('skr1_short')).toBe(false);
		expect(isRecipientCapability('other_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe(false);
		await expect(hashRecipientCapability('skr1_short')).rejects.toThrow(
			'Invalid recipient capability token'
		);
	});

	it('constructs a non-localized public signing path', async () => {
		const capability = await issueRecipientCapability();
		expect(recipientSigningPath(capability.token)).toBe(`/s/${capability.token}`);
	});
});
