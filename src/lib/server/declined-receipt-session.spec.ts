import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	DECLINED_RECEIPT_COOKIE_MAX_LENGTH,
	DECLINED_RECEIPT_COOKIE_OPTIONS,
	DECLINED_RECEIPT_COOKIE_PREFIX,
	declinedReceiptCookieName,
	isDeclinedReceiptExpired,
	sealDeclinedReceiptSession,
	type DeclinedReceiptSessionLocator,
	unsealDeclinedReceiptSession
} from './declined-receipt-session';
import { sealRecipientSession, unsealRecipientSession } from './recipient-session';

const locator: DeclinedReceiptSessionLocator = {
	version: 1,
	envelopeId: '01910000-0000-7000-8000-000000000002',
	recipientId: '01910000-0000-7000-8000-000000000003',
	idempotencyKey: 'decline-command-1',
	capabilityHash: 'a'.repeat(64),
	declinedAt: '2026-09-12T01:02:03.000Z',
	expiresAt: '2026-10-12T01:02:03.000Z'
};
const otherEnvelopeId: string = '01910000-0000-7000-8000-000000000012';
const recipientCapability: string = `skr1_${'A'.repeat(43)}`;

beforeEach((): void => {
	privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('declined receipt session sealing', () => {
	it('exposes a host-only, root-path, 30-day, envelope-scoped receipt cookie contract', () => {
		expect(declinedReceiptCookieName(locator.envelopeId)).toBe(
			`${DECLINED_RECEIPT_COOKIE_PREFIX}${locator.envelopeId}`
		);
		expect(declinedReceiptCookieName('not-a-uuid')).toBeNull();
		expect(DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30);
		expect(DECLINED_RECEIPT_COOKIE_OPTIONS).toEqual({
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			maxAge: 60 * 60 * 24 * 30
		});
	});

	it('round-trips a strict receipt locator with randomized, bounded cookie-safe ciphertext', async () => {
		const first: string = await sealDeclinedReceiptSession(locator);
		const second: string = await sealDeclinedReceiptSession(locator);

		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(first.length).toBeLessThanOrEqual(DECLINED_RECEIPT_COOKIE_MAX_LENGTH);
		await expect(unsealDeclinedReceiptSession(first, locator.envelopeId)).resolves.toEqual(locator);
		await expect(unsealDeclinedReceiptSession(second, locator.envelopeId)).resolves.toEqual(
			locator
		);
	});

	it('fails closed for tampering, malformed encoding, oversized input, and key changes', async () => {
		const sealed: string = await sealDeclinedReceiptSession(locator);
		const tampered: string = `${sealed[0] === 'A' ? 'B' : 'A'}${sealed.slice(1)}`;

		await expect(unsealDeclinedReceiptSession(tampered, locator.envelopeId)).resolves.toBeNull();
		await expect(
			unsealDeclinedReceiptSession('not+base64', locator.envelopeId)
		).resolves.toBeNull();
		await expect(
			unsealDeclinedReceiptSession(
				'A'.repeat(DECLINED_RECEIPT_COOKIE_MAX_LENGTH + 1),
				locator.envelopeId
			)
		).resolves.toBeNull();
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
		await expect(unsealDeclinedReceiptSession(sealed, locator.envelopeId)).resolves.toBeNull();
	});

	it('cannot interchange active recipient and declined receipt ciphertexts', async () => {
		const receiptCookie: string = await sealDeclinedReceiptSession(locator);
		const activeCookie: string = await sealRecipientSession(
			recipientCapability,
			locator.envelopeId
		);

		await expect(
			unsealDeclinedReceiptSession(activeCookie, locator.envelopeId)
		).resolves.toBeNull();
		await expect(unsealRecipientSession(receiptCookie, locator.envelopeId)).resolves.toBeNull();
	});

	it('fails closed when the envelope ID used to unseal does not match the locator', async () => {
		const sealed: string = await sealDeclinedReceiptSession(locator);
		await expect(unsealDeclinedReceiptSession(sealed, otherEnvelopeId)).resolves.toBeNull();
		await expect(unsealDeclinedReceiptSession(sealed, 'not-a-uuid')).resolves.toBeNull();
	});

	it.each<readonly [string, unknown]>([
		['an unknown version', { ...locator, version: 2 }],
		['an extra key', { ...locator, authority: 'active' }],
		['a missing key', omit(locator, 'recipientId')],
		['a malformed envelope UUID', { ...locator, envelopeId: 'env-1' }],
		['a UUIDv4 envelope ID', { ...locator, envelopeId: '00000000-0000-4000-8000-000000000002' }],
		['a malformed recipient UUID', { ...locator, recipientId: 'recipient-1' }],
		['an empty idempotency key', { ...locator, idempotencyKey: '' }],
		['a non-printable idempotency key', { ...locator, idempotencyKey: 'key with space' }],
		['an oversized idempotency key', { ...locator, idempotencyKey: 'a'.repeat(201) }],
		['an uppercase capability hash', { ...locator, capabilityHash: 'A'.repeat(64) }],
		['a malformed capability hash', { ...locator, capabilityHash: 'a'.repeat(63) }],
		['a non-canonical decline timestamp', { ...locator, declinedAt: '2026-09-12T01:02:03Z' }],
		['a malformed expiry timestamp', { ...locator, expiresAt: 'not-a-date' }],
		['an expiry equal to decline time', { ...locator, expiresAt: locator.declinedAt }],
		['an expiry before decline time', { ...locator, expiresAt: '2026-09-12T01:02:02.999Z' }]
	])('rejects %s', async (_description: string, candidate: unknown) => {
		await expect(
			sealDeclinedReceiptSession(candidate as DeclinedReceiptSessionLocator)
		).rejects.toThrow(/Invalid declined receipt locator/);
	});

	it('preserves a structurally valid expired locator for the caller to reject by current time', async () => {
		const expiredLocator: DeclinedReceiptSessionLocator = {
			...locator,
			declinedAt: '2026-07-01T00:00:00.000Z',
			expiresAt: '2026-07-31T00:00:00.000Z'
		};
		const sealed: string = await sealDeclinedReceiptSession(expiredLocator);
		const recovered: DeclinedReceiptSessionLocator | null = await unsealDeclinedReceiptSession(
			sealed,
			expiredLocator.envelopeId
		);

		expect(recovered).toEqual(expiredLocator);
		expect(
			recovered === null
				? false
				: isDeclinedReceiptExpired(recovered, new Date('2026-09-12T00:00:00Z'))
		).toBe(true);
		expect(isDeclinedReceiptExpired(locator, new Date('2026-09-13T00:00:00Z'))).toBe(false);
	});

	it('rejects invalid key configuration and propagates missing configuration during unseal', async () => {
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(31, 7).toString('base64');
		await expect(sealDeclinedReceiptSession(locator)).rejects.toThrow(
			/must encode exactly 32 bytes/
		);

		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
		const sealed: string = await sealDeclinedReceiptSession(locator);
		privateEnv.SESSION_ENCRYPTION_KEY = undefined;
		await expect(unsealDeclinedReceiptSession(sealed, locator.envelopeId)).rejects.toThrow(
			/is not set/
		);
	});

	it('opens a receipt cookie sealed under the previous key once the active key rotates', async () => {
		const sealedUnderOldActive: string = await sealDeclinedReceiptSession(locator);

		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = privateEnv.SESSION_ENCRYPTION_KEY;
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

		await expect(
			unsealDeclinedReceiptSession(sealedUnderOldActive, locator.envelopeId)
		).resolves.toEqual(locator);
	});

	it('fails closed once a key is retired outside the active/previous window', async () => {
		const sealedUnderRetiredKey: string = await sealDeclinedReceiptSession(locator);

		privateEnv.SESSION_ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(32, 9).toString('base64');
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString('base64');

		await expect(
			unsealDeclinedReceiptSession(sealedUnderRetiredKey, locator.envelopeId)
		).resolves.toBeNull();
	});
});

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
	const copy: Partial<T> = { ...value };
	delete copy[key];
	return copy as Omit<T, K>;
}
