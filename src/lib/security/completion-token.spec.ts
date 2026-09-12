import { describe, expect, it } from 'vitest';
import {
	completionAccessPath,
	computeCompletionAccessExpiry,
	hashCompletionToken,
	isCompletionToken,
	issueCompletionToken,
	COMPLETION_ACCESS_EXPIRY_MS,
	COMPLETION_TOKEN_PREFIX
} from './completion-token';

describe('completion-token helpers', () => {
	it('issues and validates completion tokens with skca1_ prefix', async () => {
		const issued = await issueCompletionToken();
		expect(issued.token.startsWith(COMPLETION_TOKEN_PREFIX)).toBe(true);
		expect(issued.token).toHaveLength(49);
		expect(isCompletionToken(issued.token)).toBe(true);
		expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashCompletionToken(issued.token)).toBe(issued.tokenHash);
	});

	it('rejects signing tokens or malformed strings', async () => {
		expect(isCompletionToken('skr1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe(false);
		expect(isCompletionToken('skca1_short')).toBe(false);
		expect(isCompletionToken('')).toBe(false);
		await expect(hashCompletionToken('invalid-token')).rejects.toThrow('Invalid completion token');
		expect(() => completionAccessPath('invalid-token')).toThrow('Invalid completion token');
	});

	it('computes completion access path', async () => {
		const issued = await issueCompletionToken();
		expect(completionAccessPath(issued.token)).toBe(`/c/${issued.token}`);
	});

	it('computes 30-day access expiry', () => {
		const now = new Date('2026-09-12T12:00:00.000Z');
		const expiry = computeCompletionAccessExpiry(now);
		expect(expiry).toBe('2026-10-12T12:00:00.000Z');
		expect(Date.parse(expiry) - now.valueOf()).toBe(COMPLETION_ACCESS_EXPIRY_MS);
	});
});
