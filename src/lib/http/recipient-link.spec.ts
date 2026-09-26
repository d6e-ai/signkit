import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type {
	AuthorizedRecipientDeclinedReceipt,
	RecipientDeclinedReceiptApplicationPort
} from '$lib/application/signing/recipient-declined-receipt';
import type {
	AuthorizedRecipientCompletedReceipt,
	RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import {
	DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	declinedReceiptCookieName
} from '$lib/server/declined-receipt-session';
import {
	COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	completedReceiptCookieName
} from '$lib/server/completed-receipt-session';
import {
	RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS,
	recipientSessionCookieName
} from '$lib/server/recipient-session';
import {
	createRecipientLinkHandler,
	type RecipientLinkApplicationResolver,
	type RecipientLinkReceiptOptions
} from './recipient-link';

const token: string = `skr1_${'A'.repeat(43)}`;
const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const otherEnvelopeId: string = '01910000-0000-7000-8000-000000000011';
const activeCookieName: string = recipientSessionCookieName(envelopeId) as string;
const declinedCookieName: string = declinedReceiptCookieName(envelopeId) as string;
const completedCookieName: string = completedReceiptCookieName(envelopeId) as string;
const otherActiveCookieName: string = recipientSessionCookieName(otherEnvelopeId) as string;
const context: RecipientSigningContext = {
	envelopeId,
	recipientId: '01910000-0000-7000-8000-000000000002',
	recipientName: 'Private Recipient',
	recipientLocale: 'ja',
	recipientRole: 'signer',
	recipientStatus: 'pending',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'sent',
	expiresAt: '2026-11-11T00:00:00.000Z',
	sentRevision: {
		commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		archiveKey: 'private/archive.git.gz',
		archiveSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	}
};

const declinedReceipt: AuthorizedRecipientDeclinedReceipt = {
	receipt: {
		envelopeId,
		recipientId: '01910000-0000-7000-8000-000000000002',
		recipientStatus: 'declined',
		envelopeStatus: 'declined',
		declinedAt: '2026-09-11T00:02:00.000Z',
		locale: 'ja'
	},
	locator: {
		envelopeId,
		recipientId: '01910000-0000-7000-8000-000000000002',
		idempotencyKey: 'decline-1',
		capabilityHash: 'b'.repeat(64),
		declinedAt: '2026-09-11T00:02:00.000Z',
		expiresAt: '2026-10-11T00:02:00.000Z'
	}
};

interface TestEvent {
	jar: Record<string, string>;
	cookieDelete: ReturnType<typeof vi.fn>;
	cookieGet: ReturnType<typeof vi.fn>;
	cookieSet: ReturnType<typeof vi.fn>;
	event: RequestEvent;
}

function testEvent(
	value: string = token,
	protocol: 'http:' | 'https:' = 'https:',
	cookies: Record<string, string> = {}
): TestEvent {
	const jar: Record<string, string> = { ...cookies };
	const cookieDelete = vi.fn((name: string): void => {
		delete jar[name];
	});
	const cookieGet = vi.fn((name: string): string | undefined => jar[name]);
	const cookieSet = vi.fn((name: string, value: string): void => {
		jar[name] = value;
	});
	const url: URL = new URL(`${protocol}//signkit.example/s/${value}`);
	return {
		jar,
		cookieDelete,
		cookieGet,
		cookieSet,
		event: {
			cookies: { delete: cookieDelete, get: cookieGet, set: cookieSet },
			params: { token: value },
			platform: { env: { DB: {} as D1Database } },
			url
		} as unknown as RequestEvent
	};
}

function application(
	result: RecipientSigningContext | null = context
): RecipientAccessApplicationPort {
	return { resolve: vi.fn(async (): Promise<RecipientSigningContext | null> => result) };
}

function receiptApplication(
	result: AuthorizedRecipientDeclinedReceipt | null = declinedReceipt
): RecipientDeclinedReceiptApplicationPort {
	return {
		recoverByToken: vi.fn(async (): Promise<AuthorizedRecipientDeclinedReceipt | null> => result),
		resolveLocator: vi.fn(async (): Promise<AuthorizedRecipientDeclinedReceipt | null> => result)
	};
}

function receiptOptions(
	result: AuthorizedRecipientDeclinedReceipt | null = declinedReceipt
): RecipientLinkReceiptOptions {
	return {
		resolveApplication: vi.fn(() => receiptApplication(result)),
		sealSession: vi.fn(async (): Promise<string> => 'sealed-receipt')
	};
}

const completedReceipt: AuthorizedRecipientCompletedReceipt = {
	receipt: {
		envelopeId,
		recipientId: '01910000-0000-7000-8000-000000000002',
		recipientStatus: 'completed',
		action: 'signed',
		completedAt: '2026-09-11T00:02:00.000Z',
		envelopeStatus: 'in_progress',
		envelopeCompletedByThisAction: false,
		locale: 'ja'
	},
	locator: {
		envelopeId,
		recipientId: '01910000-0000-7000-8000-000000000002',
		idempotencyKey: 'sign-1',
		capabilityHash: 'b'.repeat(64),
		action: 'signed',
		completedAt: '2026-09-11T00:02:00.000Z',
		expiresAt: '2026-10-11T00:02:00.000Z'
	}
};

function completedReceiptApplication(
	result: AuthorizedRecipientCompletedReceipt | null = completedReceipt
): RecipientCompletedReceiptApplicationPort {
	return {
		recoverByToken: vi.fn(async (): Promise<AuthorizedRecipientCompletedReceipt | null> => result),
		resolveLocator: vi.fn(async (): Promise<AuthorizedRecipientCompletedReceipt | null> => result)
	};
}

/** Declined evidence is absent, so the completed path is the one under test. */
function completedReceiptOptions(
	result: AuthorizedRecipientCompletedReceipt | null = completedReceipt
): RecipientLinkReceiptOptions {
	return {
		...receiptOptions(null),
		resolveCompletedApplication: vi.fn(() => completedReceiptApplication(result)),
		sealCompletedSession: vi.fn(async (): Promise<string> => 'sealed-completed-receipt')
	};
}

describe('recipient link exchange', () => {
	it('rejects malformed path capabilities before resolving persistence', async () => {
		const input: TestEvent = testEvent('malformed');
		const resolver: RecipientLinkApplicationResolver = vi.fn(() => application());
		const response: Response = await createRecipientLinkHandler(resolver)(input.event);

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/sign?access=invalid');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(resolver).not.toHaveBeenCalled();
		expect(input.cookieDelete).not.toHaveBeenCalled();
	});

	it('exchanges an active capability for an envelope-scoped HttpOnly cookie and clean locale URL', async () => {
		const input: TestEvent = testEvent();
		const app: RecipientAccessApplicationPort = application();
		const sealer = vi.fn(async (): Promise<string> => 'sealed-cookie');
		const receipts: RecipientLinkReceiptOptions = receiptOptions();
		const response: Response = await createRecipientLinkHandler(
			() => app,
			sealer,
			() => new Date('2026-09-11T00:00:00.000Z'),
			false,
			receipts
		)(input.event);

		expect(app.resolve).toHaveBeenCalledWith(token, '2026-09-11T00:00:00.000Z');
		expect(sealer).toHaveBeenCalledWith(token, envelopeId);
		expect(input.cookieSet).toHaveBeenCalledWith(activeCookieName, 'sealed-cookie', {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			maxAge: RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS
		});
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe(`/ja/sign/${envelopeId}`);
		expect(response.headers.get('location')).not.toContain(token);
		expect(JSON.stringify([...response.headers.entries()])).not.toContain(token);
		expect(receipts.resolveApplication).not.toHaveBeenCalled();
		expect(input.cookieDelete).not.toHaveBeenCalled();
	});

	it('does not delete a terminal declined receipt when a stale active /s later sets an invalid live cookie', async () => {
		const input: TestEvent = testEvent(token, 'https:', {
			[declinedCookieName]: 'terminal-receipt'
		});
		const sealer = vi.fn(async (): Promise<string> => {
			// Concurrent terminal decline has already persisted the receipt cookie.
			return 'stale-live-cookie';
		});
		const response: Response = await createRecipientLinkHandler(
			() => application(),
			sealer,
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);

		expect(input.jar[activeCookieName]).toBe('stale-live-cookie');
		expect(input.jar[declinedCookieName]).toBe('terminal-receipt');
		expect(input.cookieDelete).not.toHaveBeenCalled();
		expect(response.headers.get('location')).toBe(`/ja/sign/${envelopeId}`);
	});

	it('does not guess a cookie or expose the token when the envelope ID is not UUIDv7', async () => {
		const input: TestEvent = testEvent();
		const response: Response = await createRecipientLinkHandler(
			() => application({ ...context, envelopeId: 'env-1' }),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);

		expect(response.headers.get('location')).toBe('/sign?access=invalid');
		expect(input.cookieSet).not.toHaveBeenCalled();
		expect(input.cookieDelete).not.toHaveBeenCalled();
		expect(response.headers.get('location')).not.toContain(token);
	});

	it('recovers an inactive declined capability into a purpose-separated receipt cookie', async () => {
		const input: TestEvent = testEvent();
		const access: RecipientAccessApplicationPort = application(null);
		const receipts: RecipientLinkReceiptOptions = receiptOptions();
		const response: Response = await createRecipientLinkHandler(
			() => access,
			async (): Promise<string> => 'unused-active-cookie',
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			receipts
		)(input.event);

		expect(access.resolve).toHaveBeenCalledWith(token, '2026-09-11T00:03:00.000Z');
		expect(receipts.resolveApplication).toHaveBeenCalledTimes(1);
		expect(receipts.sealSession).toHaveBeenCalledWith({ ...declinedReceipt.locator, version: 1 });
		expect(input.cookieSet).toHaveBeenCalledWith(
			declinedCookieName,
			'sealed-receipt',
			expect.objectContaining({
				httpOnly: true,
				sameSite: 'lax',
				secure: true,
				maxAge: DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS - 60
			})
		);
		expect(input.cookieDelete).not.toHaveBeenCalledWith(activeCookieName, { path: '/' });
		expect(response.headers.get('location')).toBe(`/ja/sign/${envelopeId}`);
		expect(response.headers.get('location')).not.toContain(token);
	});

	it('clears only an active session containing the same declined capability for that envelope', async () => {
		const same: TestEvent = testEvent(token, 'https:', {
			[activeCookieName]: 'sealed-active-cookie'
		});
		const sameOptions: RecipientLinkReceiptOptions = {
			...receiptOptions(),
			unsealActiveSession: vi.fn(async (): Promise<string> => token)
		};
		await createRecipientLinkHandler(
			() => application(null),
			undefined,
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			sameOptions
		)(same.event);
		expect(sameOptions.unsealActiveSession).toHaveBeenCalledWith(
			'sealed-active-cookie',
			envelopeId
		);
		expect(same.cookieDelete).toHaveBeenCalledWith(activeCookieName, { path: '/' });
		expect(same.jar[activeCookieName]).toBeUndefined();

		const unrelated: TestEvent = testEvent(token, 'https:', {
			[activeCookieName]: 'other-active-cookie'
		});
		const unrelatedOptions: RecipientLinkReceiptOptions = {
			...receiptOptions(),
			unsealActiveSession: vi.fn(async (): Promise<string> => `skr1_${'B'.repeat(43)}`)
		};
		await createRecipientLinkHandler(
			() => application(null),
			undefined,
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			unrelatedOptions
		)(unrelated.event);
		expect(unrelatedOptions.unsealActiveSession).toHaveBeenCalledWith(
			'other-active-cookie',
			envelopeId
		);
		expect(unrelated.cookieDelete).not.toHaveBeenCalledWith(activeCookieName, {
			path: '/'
		});
		expect(unrelated.jar[activeCookieName]).toBe('other-active-cookie');
	});

	it('leaves a second envelope cookie untouched while exchanging the first', async () => {
		const input: TestEvent = testEvent(token, 'https:', {
			[otherActiveCookieName]: 'other-envelope-session'
		});
		await createRecipientLinkHandler(
			() => application(),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);

		expect(input.cookieSet).toHaveBeenCalledWith(
			activeCookieName,
			'sealed-cookie',
			expect.objectContaining({ httpOnly: true })
		);
		expect(input.cookieDelete).not.toHaveBeenCalledWith(otherActiveCookieName, { path: '/' });
		expect(input.cookieGet).not.toHaveBeenCalledWith(otherActiveCookieName);
	});

	it('preserves existing cookies and returns a clean unavailable redirect when receipt minting fails', async () => {
		const input: TestEvent = testEvent();
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const response: Response = await createRecipientLinkHandler(
			() => application(null),
			async (): Promise<string> => 'unused-active-cookie',
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			{
				resolveApplication: () => receiptApplication(),
				sealSession: async (): Promise<string> => {
					throw new Error('private locator must not be logged');
				}
			}
		)(input.event);

		expect(response.headers.get('location')).toBe('/sign?access=unavailable');
		expect(input.cookieSet).not.toHaveBeenCalled();
		expect(input.cookieDelete).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'recipient_link_exchange_failed' }));
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining('private locator'));
		error.mockRestore();
	});

	it('uses a non-secure cookie only for local HTTP development', async () => {
		const input: TestEvent = testEvent(token, 'http:');
		input.event.url = new URL(`http://localhost/s/${token}`);
		await createRecipientLinkHandler(
			() => application(),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z'),
			true
		)(input.event);
		expect(input.cookieSet).toHaveBeenCalledWith(
			activeCookieName,
			'sealed-cookie',
			expect.objectContaining({ secure: false })
		);
	});

	it('keeps the cookie Secure for non-local HTTP and production localhost', async () => {
		const remote: TestEvent = testEvent(token, 'http:');
		await createRecipientLinkHandler(
			() => application(),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z'),
			true
		)(remote.event);
		expect(remote.cookieSet).toHaveBeenCalledWith(
			activeCookieName,
			'sealed-cookie',
			expect.objectContaining({ secure: true })
		);

		const productionLocal: TestEvent = testEvent(token, 'http:');
		productionLocal.event.url = new URL(`http://localhost/s/${token}`);
		await createRecipientLinkHandler(
			() => application(),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z'),
			false
		)(productionLocal.event);
		expect(productionLocal.cookieSet).toHaveBeenCalledWith(
			activeCookieName,
			'sealed-cookie',
			expect.objectContaining({ secure: true })
		);
	});

	it('uses the recipient expiry when it is earlier than the cookie lifetime cap', async () => {
		const input: TestEvent = testEvent();
		await createRecipientLinkHandler(
			() =>
				application({
					...context,
					recipientLocale: 'en',
					expiresAt: '2026-09-11T01:00:00.000Z'
				}),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);
		expect(input.cookieSet).toHaveBeenCalledWith(
			activeCookieName,
			'sealed-cookie',
			expect.objectContaining({ maxAge: 3600 })
		);
	});

	it.each([
		['exact expiry', '2026-09-11T00:00:00.000Z'],
		['sub-second remainder', '2026-09-11T00:00:00.500Z'],
		['invalid expiry', 'not-a-timestamp']
	])('does not create a cookie for %s', async (_name, expiresAt) => {
		const input: TestEvent = testEvent();
		const response: Response = await createRecipientLinkHandler(
			() => application({ ...context, expiresAt }),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);
		expect(response.headers.get('location')).toBe('/sign?access=invalid');
		expect(input.cookieSet).not.toHaveBeenCalled();
	});

	it('does not destroy an existing session when sealing fails', async () => {
		const input: TestEvent = testEvent();
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const response: Response = await createRecipientLinkHandler(
			() => application(),
			async (): Promise<string> => {
				throw new Error('secret material that must not be logged');
			}
		)(input.event);
		expect(response.headers.get('location')).toBe('/sign?access=unavailable');
		expect(input.cookieDelete).not.toHaveBeenCalled();
		expect(input.cookieSet).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'recipient_link_exchange_failed' }));
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining('secret material'));
		error.mockRestore();
	});

	it.each([
		['missing persistence', null, '/sign?access=unavailable'],
		['inactive capability', application(null), '/sign?access=invalid']
	] as const)('preserves an existing session for %s', async (_name, resolved, location) => {
		const input: TestEvent = testEvent();
		const response: Response = await createRecipientLinkHandler(() => resolved)(input.event);
		expect(response.headers.get('location')).toBe(location);
		expect(input.cookieDelete).not.toHaveBeenCalled();
		expect(input.cookieSet).not.toHaveBeenCalled();
	});

	it('recovers a completed action into its own purpose-separated receipt cookie', async () => {
		const input: TestEvent = testEvent();
		const access: RecipientAccessApplicationPort = application(null);
		const receipts: RecipientLinkReceiptOptions = completedReceiptOptions();
		const response: Response = await createRecipientLinkHandler(
			() => access,
			async (): Promise<string> => 'unused-active-cookie',
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			receipts
		)(input.event);

		expect(receipts.resolveApplication).toHaveBeenCalledTimes(1);
		expect(receipts.resolveCompletedApplication).toHaveBeenCalledTimes(1);
		expect(receipts.sealCompletedSession).toHaveBeenCalledWith({
			...completedReceipt.locator,
			version: 1
		});
		expect(receipts.sealSession).not.toHaveBeenCalled();
		expect(input.cookieSet).toHaveBeenCalledWith(
			completedCookieName,
			'sealed-completed-receipt',
			expect.objectContaining({
				httpOnly: true,
				sameSite: 'lax',
				secure: true,
				maxAge: COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS - 60
			})
		);
		expect(input.cookieSet).not.toHaveBeenCalledWith(
			declinedCookieName,
			expect.anything(),
			expect.anything()
		);
		expect(response.headers.get('location')).toBe(`/ja/sign/${envelopeId}`);
		expect(response.headers.get('location')).not.toContain(token);
	});

	it('prefers declined evidence and never consults the completed path for it', async () => {
		const input: TestEvent = testEvent();
		const receipts: RecipientLinkReceiptOptions = {
			...receiptOptions(),
			resolveCompletedApplication: vi.fn(() => completedReceiptApplication()),
			sealCompletedSession: vi.fn(async (): Promise<string> => 'sealed-completed-receipt')
		};
		await createRecipientLinkHandler(
			() => application(null),
			undefined,
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			receipts
		)(input.event);

		expect(receipts.resolveCompletedApplication).not.toHaveBeenCalled();
		expect(input.cookieSet).toHaveBeenCalledWith(
			declinedCookieName,
			'sealed-receipt',
			expect.anything()
		);
		expect(input.jar[completedCookieName]).toBeUndefined();
	});

	it('clears only an active session holding the same completed capability', async () => {
		const same: TestEvent = testEvent(token, 'https:', {
			[activeCookieName]: 'sealed-active-cookie'
		});
		const sameOptions: RecipientLinkReceiptOptions = {
			...completedReceiptOptions(),
			unsealActiveSession: vi.fn(async (): Promise<string> => token)
		};
		await createRecipientLinkHandler(
			() => application(null),
			undefined,
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			sameOptions
		)(same.event);
		expect(same.cookieDelete).toHaveBeenCalledWith(activeCookieName, { path: '/' });

		const unrelated: TestEvent = testEvent(token, 'https:', {
			[activeCookieName]: 'other-active-cookie'
		});
		const unrelatedOptions: RecipientLinkReceiptOptions = {
			...completedReceiptOptions(),
			unsealActiveSession: vi.fn(async (): Promise<string> => `skr1_${'B'.repeat(43)}`)
		};
		await createRecipientLinkHandler(
			() => application(null),
			undefined,
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			unrelatedOptions
		)(unrelated.event);
		expect(unrelated.cookieDelete).not.toHaveBeenCalledWith(activeCookieName, { path: '/' });
		expect(unrelated.jar[activeCookieName]).toBe('other-active-cookie');
	});

	it('leaves a completed receipt for another envelope untouched', async () => {
		const otherCompletedCookieName: string = completedReceiptCookieName(otherEnvelopeId) as string;
		const input: TestEvent = testEvent(token, 'https:', {
			[otherCompletedCookieName]: 'other-envelope-receipt'
		});
		await createRecipientLinkHandler(
			() => application(null),
			undefined,
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			completedReceiptOptions()
		)(input.event);

		expect(input.cookieDelete).not.toHaveBeenCalledWith(otherCompletedCookieName, { path: '/' });
		expect(input.jar[otherCompletedCookieName]).toBe('other-envelope-receipt');
	});

	it.each([
		['no completed resolver is configured', receiptOptions(null), '/sign?access=invalid'],
		[
			'completed persistence is missing',
			{ ...receiptOptions(null), resolveCompletedApplication: () => null },
			'/sign?access=unavailable'
		],
		['no completed evidence exists', completedReceiptOptions(null), '/sign?access=invalid'],
		[
			'the receipt has already expired',
			completedReceiptOptions({
				...completedReceipt,
				locator: { ...completedReceipt.locator, expiresAt: '2026-09-11T00:03:00.000Z' }
			}),
			'/sign?access=invalid'
		],
		[
			'the receipt envelope is not a UUIDv7',
			completedReceiptOptions({
				...completedReceipt,
				receipt: { ...completedReceipt.receipt, envelopeId: 'envelope-1' }
			}),
			'/sign?access=invalid'
		]
	])('returns a generic response when %s', async (_name, receipts, location) => {
		const input: TestEvent = testEvent();
		const response: Response = await createRecipientLinkHandler(
			() => application(null),
			undefined,
			() => new Date('2026-09-11T00:03:00.000Z'),
			false,
			receipts as RecipientLinkReceiptOptions
		)(input.event);

		expect(response.headers.get('location')).toBe(location);
		expect(input.cookieSet).not.toHaveBeenCalled();
		expect(input.cookieDelete).not.toHaveBeenCalled();
	});
});
