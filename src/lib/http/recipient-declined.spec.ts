import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientDeclinedApplicationPort,
	RecipientDeclinedResult
} from '$lib/application/signing/recipient-declined';
import type {
	AuthorizedRecipientDeclinedReceipt,
	RecipientDeclinedReceiptApplicationPort
} from '$lib/application/signing/recipient-declined-receipt';
import { declinedReceiptCookieName } from '$lib/server/declined-receipt-session';
import { recipientSessionCookieName } from '$lib/server/recipient-session';
import {
	createRecipientDeclinedHandler,
	type RecipientDeclinedApplicationResolver,
	type RecipientDeclinedHandlerOptions
} from './recipient-declined';
import { createRecipientRequestEvent } from './recipient-request-event-test-support';

const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';
const token: string = `skr1_${'A'.repeat(43)}`;

function requestEvent(
	options: {
		origin?: string | null;
		idempotencyKey?: string;
		body?: unknown;
		cookie?: string;
	} = {}
): {
	event: RequestEvent;
	deleted: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
} {
	const { event, deleted, cookies } = createRecipientRequestEvent({
		pathname: '/api/v1/signing/decline',
		defaultBody: { envelopeId, recipientId },
		...options
	});
	const set = vi.fn();
	cookies.set = set;
	return { event, deleted, set };
}

function application(result: RecipientDeclinedResult): RecipientDeclinedApplicationPort {
	return { decline: vi.fn(async (): Promise<RecipientDeclinedResult> => result) };
}

const published: RecipientDeclinedResult = {
	outcome: 'published',
	result: {
		envelopeId,
		recipientId,
		recipientRole: 'signer',
		routingOrder: 1,
		sentCommitSha: 'a'.repeat(40),
		envelopeStatus: 'declined',
		declinedAt: '2026-09-11T00:02:00.000Z',
		auditEventId: 'private-audit-id'
	}
};

const authorizedReceipt: AuthorizedRecipientDeclinedReceipt = {
	receipt: {
		envelopeId,
		recipientId,
		recipientStatus: 'declined',
		envelopeStatus: 'declined',
		declinedAt: '2026-09-11T00:02:00.000Z',
		locale: 'ja'
	},
	locator: {
		organizationId: '01910000-0000-7000-8000-000000000003',
		envelopeId,
		recipientId,
		idempotencyKey: 'decline-1',
		capabilityHash: 'b'.repeat(64),
		declinedAt: '2026-09-11T00:02:00.000Z',
		expiresAt: '2026-10-11T00:02:00.000Z'
	}
};

function receiptApplication(
	result: AuthorizedRecipientDeclinedReceipt | null = authorizedReceipt
): RecipientDeclinedReceiptApplicationPort {
	return {
		recoverByToken: vi.fn(async (): Promise<AuthorizedRecipientDeclinedReceipt | null> => result),
		resolveLocator: vi.fn(async (): Promise<AuthorizedRecipientDeclinedReceipt | null> => result)
	};
}

function receiptOptions(
	result: AuthorizedRecipientDeclinedReceipt | null = authorizedReceipt
): RecipientDeclinedHandlerOptions {
	return {
		resolveReceiptApplication: vi.fn(() => receiptApplication(result)),
		sealReceiptSession: vi.fn(async (): Promise<string> => 'sealed-receipt'),
		now: (): Date => new Date('2026-09-11T00:03:00.000Z')
	};
}

describe('recipient declined HTTP handler', () => {
	it('rejects cross-origin and origin-less POSTs before reading the cookie', async () => {
		for (const origin of ['https://attacker.example', null]) {
			const { event } = requestEvent({ origin, idempotencyKey: 'decline-1' });
			const unseal = vi.fn(async (): Promise<string> => token);
			const resolver: RecipientDeclinedApplicationResolver = vi.fn(() => application(published));
			const response: Response = await createRecipientDeclinedHandler(resolver, unseal)(event);
			expect(response.status).toBe(403);
			expect(unseal).not.toHaveBeenCalled();
			expect(resolver).not.toHaveBeenCalled();
		}
	});

	it('requires a bounded idempotency key and strict expected IDs', async () => {
		for (const options of [
			{},
			{ idempotencyKey: 'decline-1', body: { envelopeId, recipientId, extra: true } },
			{ idempotencyKey: 'decline-1', body: { envelopeId: 'not-a-uuid', recipientId } }
		]) {
			const { event } = requestEvent(options);
			const response: Response = await createRecipientDeclinedHandler(
				() => application(published),
				async (): Promise<string> => token
			)(event);
			expect(response.status).toBe(400);
		}
	});

	it.each(['key with space', 'a'.repeat(201), `key-${String.fromCharCode(127)}`])(
		'rejects invalid Idempotency-Key value %j before unsealing the session',
		async (idempotencyKey: string) => {
			const { event } = requestEvent({ idempotencyKey });
			const unseal = vi.fn(async (): Promise<string> => token);
			const response: Response = await createRecipientDeclinedHandler(
				() => application(published),
				unseal
			)(event);
			expect(response.status).toBe(400);
			expect(unseal).not.toHaveBeenCalled();
		}
	);

	it('rejects a non-JSON content type before reading the cookie', async () => {
		const { event } = requestEvent({ idempotencyKey: 'decline-1' });
		(event.request.headers as Headers).set('content-type', 'text/plain');
		const unseal = vi.fn(async (): Promise<string> => token);
		const response: Response = await createRecipientDeclinedHandler(
			() => application(published),
			unseal
		)(event);
		expect(response.status).toBe(415);
		expect(unseal).not.toHaveBeenCalled();
	});

	it('rejects an oversized request body', async () => {
		const { event } = requestEvent({
			idempotencyKey: 'decline-1',
			body: { envelopeId, recipientId, padding: 'x'.repeat(8 * 1024) }
		});
		const response: Response = await createRecipientDeclinedHandler(
			() => application(published),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(413);
	});

	it('passes only the cookie capability and expected IDs to the application', async () => {
		const app: RecipientDeclinedApplicationPort = application(published);
		const receiptApp: RecipientDeclinedReceiptApplicationPort = receiptApplication();
		const sealReceiptSession = vi.fn(async (): Promise<string> => 'sealed-receipt');
		const { event, deleted, set } = requestEvent({ idempotencyKey: 'decline-1' });
		const response: Response = await createRecipientDeclinedHandler(
			() => app,
			async (): Promise<string> => token,
			{
				resolveReceiptApplication: () => receiptApp,
				sealReceiptSession,
				now: (): Date => new Date('2026-09-11T00:03:00.000Z')
			}
		)(event);

		expect(app.decline).toHaveBeenCalledWith({
			token,
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: recipientId,
			idempotencyKey: 'decline-1'
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('vary')).toBe('Cookie, Origin');
		expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
		expect(deleted).not.toHaveBeenCalledWith(
			recipientSessionCookieName('01910000-0000-7000-8000-000000000099'),
			{ path: '/' }
		);
		expect(set).toHaveBeenCalledWith(
			declinedReceiptCookieName(envelopeId),
			'sealed-receipt',
			expect.objectContaining({ httpOnly: true, sameSite: 'lax', secure: true })
		);
		expect(receiptApp.recoverByToken).toHaveBeenCalledWith(
			token,
			new Date('2026-09-11T00:03:00.000Z')
		);
		expect(sealReceiptSession).toHaveBeenCalledWith({
			...authorizedReceipt.locator,
			version: 1
		});
		const body: unknown = await response.json();
		expect(body).toEqual({
			declined: {
				envelopeId,
				recipientId,
				recipientStatus: 'declined',
				envelopeStatus: 'declined',
				declinedAt: '2026-09-11T00:02:00.000Z'
			}
		});
		const serialized: string = JSON.stringify(body);
		expect(serialized).not.toMatch(
			/sentCommitSha|auditEventId|private-audit|skr1_|routingOrder|organizationId/
		);
	});

	it('returns a replay header and still clears the cookie for same-recipient retries', async () => {
		const replayed: RecipientDeclinedResult = { ...published, outcome: 'replayed' };
		const { event, deleted } = requestEvent({ idempotencyKey: 'decline-tab-2' });
		const response: Response = await createRecipientDeclinedHandler(
			() => application(replayed),
			async (): Promise<string> => token,
			receiptOptions()
		)(event);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
	});

	it('preserves active authority and returns a secret-free 503 when receipt recovery fails after publication', async () => {
		const { event, deleted, set } = requestEvent({ idempotencyKey: 'decline-1' });
		const response: Response = await createRecipientDeclinedHandler(
			() => application(published),
			async (): Promise<string> => token,
			receiptOptions(null)
		)(event);

		expect(response.status).toBe(503);
		expect(deleted).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		const serialized: string = JSON.stringify(await response.json());
		expect(serialized).not.toMatch(/skr1_|capabilityHash|organizationId|locator|auditEventId/);
	});

	it('rejects mismatched durable evidence without minting or clearing cookies', async () => {
		const { event, deleted, set } = requestEvent({ idempotencyKey: 'decline-1' });
		const response: Response = await createRecipientDeclinedHandler(
			() => application(published),
			async (): Promise<string> => token,
			receiptOptions({
				...authorizedReceipt,
				receipt: { ...authorizedReceipt.receipt, recipientId: 'different-recipient' }
			})
		)(event);

		expect(response.status).toBe(503);
		expect(deleted).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});

	it('preserves the cookie for opaque context_mismatch and role_not_actionable outcomes', async () => {
		for (const outcome of ['context_mismatch', 'role_not_actionable'] as const) {
			const { event, deleted } = requestEvent({ idempotencyKey: 'decline-a' });
			const response: Response = await createRecipientDeclinedHandler(
				() => application({ outcome }),
				async (): Promise<string> => token
			)(event);
			expect(response.status).toBe(404);
			expect(deleted).not.toHaveBeenCalled();
		}
	});

	it('clears a definitively inactive or unreadable recipient session', async () => {
		for (const mode of ['inactive', 'unreadable'] as const) {
			const { event, deleted } = requestEvent({ idempotencyKey: 'decline-1' });
			const response: Response = await createRecipientDeclinedHandler(
				() => application({ outcome: 'not_found' }),
				async (): Promise<string | null> => (mode === 'unreadable' ? null : token)
			)(event);
			expect(response.status).toBe(404);
			expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
		}
	});

	it.each([
		[{ outcome: 'idempotency_conflict' } as const, 409],
		[{ outcome: 'audit_conflict' } as const, 409],
		[{ outcome: 'delivery_in_flight' } as const, 409],
		[{ outcome: 'integrity_error' } as const, 503]
	])('maps %j to a fixed RFC 9457 response', async (result, status) => {
		const { event, deleted } = requestEvent({ idempotencyKey: 'decline-1' });
		const response: Response = await createRecipientDeclinedHandler(
			() => application(result),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(status);
		expect(response.headers.get('content-type')).toContain('application/problem+json');
		expect(deleted).not.toHaveBeenCalled();
	});

	it('sets Retry-After for transient audit and delivery conflicts', async () => {
		for (const outcome of ['audit_conflict', 'delivery_in_flight'] as const) {
			const { event } = requestEvent({ idempotencyKey: 'decline-1' });
			const response: Response = await createRecipientDeclinedHandler(
				() => application({ outcome }),
				async (): Promise<string> => token
			)(event);
			expect(response.headers.get('retry-after')).toBe('1');
		}
	});
});
