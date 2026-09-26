import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	AuthorizedRecipientCompletedReceipt,
	RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
import {
	COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	completedReceiptCookieName
} from '$lib/server/completed-receipt-session';
import { recipientSessionCookieName } from '$lib/server/recipient-session';
import {
	type CommittedRecipientAction,
	exchangeCompletedReceiptCookie,
	type RecipientCompletedReceiptHandlerOptions
} from './recipient-completed-receipt';

const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';
const otherEnvelopeId: string = '01910000-0000-7000-8000-000000000011';
const otherRecipientId: string = '01910000-0000-7000-8000-000000000012';
const token: string = `skr1_${'A'.repeat(43)}`;
const completedAt: string = '2026-09-11T00:02:00.000Z';
const expiresAt: string = '2026-10-11T00:02:00.000Z';
const resolvedAt: Date = new Date('2026-09-11T00:02:30.000Z');
const receiptCookie: string = completedReceiptCookieName(envelopeId) as string;
const sessionCookie: string = recipientSessionCookieName(envelopeId) as string;

const committed: CommittedRecipientAction = {
	envelopeId,
	recipientId,
	action: 'signed',
	idempotencyKey: 'sign-1',
	completedAt
};

function evidence(
	overrides: Partial<AuthorizedRecipientCompletedReceipt['receipt']> = {},
	locatorOverrides: Partial<AuthorizedRecipientCompletedReceipt['locator']> = {}
): AuthorizedRecipientCompletedReceipt {
	return {
		receipt: {
			envelopeId,
			recipientId,
			recipientStatus: 'completed',
			action: 'signed',
			completedAt,
			envelopeStatus: 'in_progress',
			envelopeCompletedByThisAction: false,
			locale: 'en',
			...overrides
		},
		locator: {
			envelopeId,
			recipientId,
			idempotencyKey: 'sign-1',
			capabilityHash: 'b'.repeat(64),
			action: 'signed',
			completedAt,
			expiresAt,
			...locatorOverrides
		}
	};
}

interface CookieJar {
	cookies: Cookies;
	set: ReturnType<typeof vi.fn>;
	deleted: ReturnType<typeof vi.fn>;
	order: string[];
}

function cookieJar(deletionFailure?: Error): CookieJar {
	const order: string[] = [];
	const set = vi.fn((name: string): void => {
		order.push(`set:${name}`);
	});
	const deleted = vi.fn((name: string): void => {
		order.push(`delete:${name}`);
		if (deletionFailure !== undefined) throw deletionFailure;
	});
	return { cookies: { set, delete: deleted } as unknown as Cookies, set, deleted, order };
}

function receiptApplication(
	authorized: AuthorizedRecipientCompletedReceipt | null
): RecipientCompletedReceiptApplicationPort {
	return {
		recoverByToken: vi.fn(
			async (): Promise<AuthorizedRecipientCompletedReceipt | null> => authorized
		),
		resolveLocator: vi.fn(
			async (): Promise<AuthorizedRecipientCompletedReceipt | null> => authorized
		)
	};
}

function receiptOptions(
	authorized: AuthorizedRecipientCompletedReceipt | null = evidence(),
	overrides: Partial<RecipientCompletedReceiptHandlerOptions> = {}
): RecipientCompletedReceiptHandlerOptions {
	return {
		resolveReceiptApplication: vi.fn(() => receiptApplication(authorized)),
		sealReceiptSession: vi.fn(async (): Promise<string> => 'sealed-completed-receipt'),
		now: (): Date => resolvedAt,
		...overrides
	};
}

async function exchange(
	options: RecipientCompletedReceiptHandlerOptions | undefined,
	overrides: { committed?: CommittedRecipientAction; url?: URL; jar?: CookieJar } = {}
): Promise<{ granted: boolean; jar: CookieJar }> {
	const jar: CookieJar = overrides.jar ?? cookieJar();
	const granted: boolean = await exchangeCompletedReceiptCookie({
		token,
		committed: overrides.committed ?? committed,
		url: overrides.url ?? new URL('https://signkit.example/api/v1/signing/sign'),
		platform: undefined,
		cookies: jar.cookies,
		options
	});
	return { granted, jar };
}

describe('completed receipt cookie exchange', () => {
	it('seals the envelope-bound read-only locator before clearing the live signing cookie', async () => {
		const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
		const { granted, jar } = await exchange(options);

		expect(granted).toBe(true);
		expect(options.sealReceiptSession).toHaveBeenCalledWith({
			version: 1,
			envelopeId,
			recipientId,
			idempotencyKey: 'sign-1',
			capabilityHash: 'b'.repeat(64),
			action: 'signed',
			completedAt,
			expiresAt
		});
		expect(jar.set).toHaveBeenCalledWith(receiptCookie, 'sealed-completed-receipt', {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			maxAge: 30 * 24 * 60 * 60 - 30
		});
		expect(jar.deleted).toHaveBeenCalledWith(sessionCookie, { path: '/' });
		expect(jar.order).toEqual([`set:${receiptCookie}`, `delete:${sessionCookie}`]);
	});

	it('caps the receipt cookie lifetime at the bounded retention window', async () => {
		const options: RecipientCompletedReceiptHandlerOptions = receiptOptions(
			evidence({}, { expiresAt: '2027-09-11T00:02:00.000Z' })
		);
		const { granted, jar } = await exchange(options);

		expect(granted).toBe(true);
		expect(jar.set).toHaveBeenCalledWith(
			receiptCookie,
			'sealed-completed-receipt',
			expect.objectContaining({ maxAge: COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS })
		);
	});

	it('accepts evidence whose whole-envelope progress advanced past this command', async () => {
		// Another recipient can complete the envelope between this publication or
		// replay and the receipt read. That race must not cost this recipient the
		// receipt for their own, already durable action.
		const options: RecipientCompletedReceiptHandlerOptions = receiptOptions(
			evidence({ envelopeStatus: 'completed', envelopeCompletedByThisAction: false })
		);
		const { granted, jar } = await exchange(options);

		expect(granted).toBe(true);
		expect(jar.set).toHaveBeenCalledWith(
			receiptCookie,
			'sealed-completed-receipt',
			expect.anything()
		);
	});

	it('accepts a canonicalized evidence timestamp for the same instant', async () => {
		const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
		const { granted } = await exchange(options, {
			committed: { ...committed, completedAt: '2026-09-11T00:02:00Z' }
		});

		expect(granted).toBe(true);
	});

	it.each([
		['missing evidence', null, committed],
		['a foreign envelope', evidence({ envelopeId: otherEnvelopeId }), committed],
		['a foreign locator envelope', evidence({}, { envelopeId: otherEnvelopeId }), committed],
		['a foreign recipient', evidence({ recipientId: otherRecipientId }), committed],
		['a foreign locator recipient', evidence({}, { recipientId: otherRecipientId }), committed],
		['the other terminal action', evidence({ action: 'approved' }), committed],
		['a locator for the other terminal action', evidence({}, { action: 'approved' }), committed],
		['a different idempotency key', evidence({}, { idempotencyKey: 'sign-2' }), committed],
		[
			'a different terminal timestamp',
			evidence({ completedAt: '2026-09-11T00:03:00.000Z' }),
			committed
		],
		[
			'a locator timestamp that drifted from the receipt',
			evidence({}, { completedAt: '2026-09-11T00:03:00.000Z' }),
			committed
		],
		['expired evidence', evidence({}, { expiresAt: '2026-09-11T00:02:10.000Z' }), committed]
	])(
		'grants no read-only authority for %s and still clears the live cookie',
		async (_label, authorized, action) => {
			const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
			try {
				const options: RecipientCompletedReceiptHandlerOptions = receiptOptions(authorized);
				const { granted, jar } = await exchange(options, { committed: action });

				expect(granted).toBe(false);
				expect(jar.set).not.toHaveBeenCalled();
				expect(jar.deleted).toHaveBeenCalledWith(sessionCookie, { path: '/' });
				expect(diagnostic).toHaveBeenCalledWith(
					JSON.stringify({
						event: 'recipient_completed_receipt_exchange_failed',
						action: 'signed'
					})
				);
			} finally {
				diagnostic.mockRestore();
			}
		}
	);

	it.each([
		[
			'an unavailable receipt application',
			receiptOptions(evidence(), { resolveReceiptApplication: () => null })
		],
		[
			'a throwing receipt application',
			receiptOptions(evidence(), {
				resolveReceiptApplication: (): never => {
					throw new Error('resolver exploded');
				}
			})
		],
		[
			'a failed seal',
			receiptOptions(evidence(), {
				sealReceiptSession: async (): Promise<string> => {
					throw new Error('sealing key unavailable');
				}
			})
		]
	])('grants no read-only authority for %s', async (_label, options) => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const { granted, jar } = await exchange(options);

			expect(granted).toBe(false);
			expect(jar.set).not.toHaveBeenCalled();
			expect(jar.deleted).toHaveBeenCalledWith(sessionCookie, { path: '/' });
			const logged: string = diagnostic.mock.calls.map(String).join('|');
			expect(logged).not.toMatch(/skr1_|sealing key unavailable|resolver exploded/);
		} finally {
			diagnostic.mockRestore();
		}
	});

	it('touches only this envelope and never keeps the live capability as a substitute', async () => {
		const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
		const { jar } = await exchange(options);

		expect(jar.set).toHaveBeenCalledTimes(1);
		expect(jar.deleted).toHaveBeenCalledTimes(1);
		expect(jar.order).not.toContain(`set:${recipientSessionCookieName(envelopeId)}`);
		expect(jar.order.every((call: string): boolean => call.includes(envelopeId))).toBe(true);
	});

	it('clears the live cookie without a diagnostic when no receipt exchange is configured', async () => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const { granted, jar } = await exchange(undefined);

			expect(granted).toBe(false);
			expect(jar.set).not.toHaveBeenCalled();
			expect(jar.deleted).toHaveBeenCalledWith(sessionCookie, { path: '/' });
			expect(diagnostic).not.toHaveBeenCalled();
		} finally {
			diagnostic.mockRestore();
		}
	});

	it('contains a failed live-cookie retirement after the receipt was already sealed', async () => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const jar: CookieJar = cookieJar(new Error('cookie serialization failed'));
			const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();

			// The command is already durable, so this must resolve rather than throw
			// a post-commit failure out to the handler.
			const { granted } = await exchange(options, { jar });

			expect(granted).toBe(true);
			expect(jar.set).toHaveBeenCalledWith(
				receiptCookie,
				'sealed-completed-receipt',
				expect.anything()
			);
			expect(jar.order).toEqual([`set:${receiptCookie}`, `delete:${sessionCookie}`]);
			expect(diagnostic).toHaveBeenCalledWith(
				JSON.stringify({
					event: 'recipient_completed_receipt_session_retirement_failed',
					action: 'signed'
				})
			);
			expect(diagnostic.mock.calls.map(String).join('|')).not.toMatch(
				/skr1_|cookie serialization failed/
			);
		} finally {
			diagnostic.mockRestore();
		}
	});

	it('contains a failed live-cookie retirement when no receipt could be proven either', async () => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const jar: CookieJar = cookieJar(new Error('cookie serialization failed'));

			const { granted } = await exchange(receiptOptions(null), { jar });

			expect(granted).toBe(false);
			expect(jar.set).not.toHaveBeenCalled();
			const logged: string[] = diagnostic.mock.calls.map(String);
			expect(logged).toEqual([
				JSON.stringify({
					event: 'recipient_completed_receipt_exchange_failed',
					action: 'signed'
				}),
				JSON.stringify({
					event: 'recipient_completed_receipt_session_retirement_failed',
					action: 'signed'
				})
			]);
		} finally {
			diagnostic.mockRestore();
		}
	});

	it.each([
		['https://signkit.example/api/v1/signing/sign', true, true],
		['http://localhost:5173/api/v1/signing/sign', true, false],
		['http://localhost:5173/api/v1/signing/sign', false, true]
	])(
		'seals %s with insecure local development %s as secure=%s',
		async (href: string, allowInsecureLocalDevelopment: boolean, secure: boolean) => {
			const options: RecipientCompletedReceiptHandlerOptions = receiptOptions(evidence(), {
				allowInsecureLocalDevelopment
			});
			const { jar } = await exchange(options, { url: new URL(href) });

			expect(jar.set).toHaveBeenCalledWith(
				receiptCookie,
				'sealed-completed-receipt',
				expect.objectContaining({ secure })
			);
		}
	);
});
