import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientApprovedApplicationPort,
	RecipientApprovedResult
} from '$lib/application/signing/recipient-approved';
import type {
	AuthorizedRecipientCompletedReceipt,
	RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
import { completedReceiptCookieName } from '$lib/server/completed-receipt-session';
import { recipientSessionCookieName } from '$lib/server/recipient-session';
import {
	createRecipientApprovedHandler,
	type RecipientApprovedApplicationResolver
} from './recipient-approved';
import type { RecipientCompletedReceiptHandlerOptions } from './recipient-completed-receipt';
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
		pathname: '/api/v1/signing/approve',
		defaultBody: { envelopeId, recipientId },
		...options
	});
	const set = vi.fn();
	cookies.set = set;
	return { event, deleted, set };
}

function application(result: RecipientApprovedResult): RecipientApprovedApplicationPort {
	return { approve: vi.fn(async (): Promise<RecipientApprovedResult> => result) };
}

const published: RecipientApprovedResult = {
	outcome: 'published',
	result: {
		envelopeId,
		recipientId,
		recipientRole: 'approver',
		routingOrder: 1,
		sentCommitSha: 'a'.repeat(40),
		envelopeStatus: 'in_progress',
		approvedAt: '2026-09-11T00:02:00.000Z',
		auditEventId: 'private-audit-id',
		completedAuditEventId: null,
		nextRoutingOrder: null
	}
};

const authorizedReceipt: AuthorizedRecipientCompletedReceipt = {
	receipt: {
		envelopeId,
		recipientId,
		recipientStatus: 'completed',
		action: 'approved',
		completedAt: '2026-09-11T00:02:00.000Z',
		envelopeStatus: 'in_progress',
		envelopeCompletedByThisAction: false,
		locale: 'en'
	},
	locator: {
		envelopeId,
		recipientId,
		idempotencyKey: 'approve-1',
		capabilityHash: 'b'.repeat(64),
		action: 'approved',
		completedAt: '2026-09-11T00:02:00.000Z',
		expiresAt: '2026-10-11T00:02:00.000Z'
	}
};

function receiptOptions(
	authorized: AuthorizedRecipientCompletedReceipt | null = authorizedReceipt
): RecipientCompletedReceiptHandlerOptions {
	const application: RecipientCompletedReceiptApplicationPort = {
		recoverByToken: vi.fn(
			async (): Promise<AuthorizedRecipientCompletedReceipt | null> => authorized
		),
		resolveLocator: vi.fn(
			async (): Promise<AuthorizedRecipientCompletedReceipt | null> => authorized
		)
	};
	return {
		resolveReceiptApplication: vi.fn(() => application),
		sealReceiptSession: vi.fn(async (): Promise<string> => 'sealed-completed-receipt'),
		now: (): Date => new Date('2026-09-11T00:02:30.000Z')
	};
}

describe('recipient approved HTTP handler', () => {
	it('accepts browserless recipient approval without touching a browser session', async () => {
		const app: RecipientApprovedApplicationPort = application(published);
		const { event, cookies, deleted } = createRecipientRequestEvent({
			pathname: '/api/v1/recipient/approve',
			defaultBody: { envelopeId, recipientId },
			origin: null,
			authorization: `Bearer ${token}`,
			idempotencyKey: 'approve-cli-1'
		});
		const set = vi.fn();
		cookies.set = set;
		const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
		const response: Response = await createRecipientApprovedHandler(
			() => app,
			async (): Promise<string> => token,
			options,
			'bearer'
		)(event);
		expect(response.status).toBe(200);
		expect(app.approve).toHaveBeenCalledWith(expect.objectContaining({ token }));
		expect(cookies.get).not.toHaveBeenCalled();
		expect(deleted).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		expect(options.resolveReceiptApplication).not.toHaveBeenCalled();
	});

	it('rejects cross-origin and origin-less POSTs before reading the cookie', async () => {
		for (const origin of ['https://attacker.example', null]) {
			const { event } = requestEvent({ origin, idempotencyKey: 'approve-1' });
			const unseal = vi.fn(async (): Promise<string> => token);
			const resolver: RecipientApprovedApplicationResolver = vi.fn(() => application(published));
			const response: Response = await createRecipientApprovedHandler(resolver, unseal)(event);
			expect(response.status).toBe(403);
			expect(unseal).not.toHaveBeenCalled();
			expect(resolver).not.toHaveBeenCalled();
		}
	});

	it('requires a bounded idempotency key and strict expected IDs', async () => {
		for (const options of [
			{},
			{ idempotencyKey: 'approve-1', body: { envelopeId, recipientId, extra: true } },
			{ idempotencyKey: 'approve-1', body: { envelopeId: 'not-a-uuid', recipientId } }
		]) {
			const { event } = requestEvent(options);
			const response: Response = await createRecipientApprovedHandler(
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
			const response: Response = await createRecipientApprovedHandler(
				() => application(published),
				unseal
			)(event);
			expect(response.status).toBe(400);
			expect(unseal).not.toHaveBeenCalled();
		}
	);

	it('rejects a non-JSON content type before reading the cookie', async () => {
		const { event } = requestEvent({ idempotencyKey: 'approve-1' });
		(event.request.headers as Headers).set('content-type', 'text/plain');
		const unseal = vi.fn(async (): Promise<string> => token);
		const response: Response = await createRecipientApprovedHandler(
			() => application(published),
			unseal
		)(event);
		expect(response.status).toBe(415);
		expect(unseal).not.toHaveBeenCalled();
	});

	it('rejects an oversized request body', async () => {
		const { event } = requestEvent({
			idempotencyKey: 'approve-1',
			body: { envelopeId, recipientId, padding: 'x'.repeat(8 * 1024) }
		});
		const response: Response = await createRecipientApprovedHandler(
			() => application(published),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(413);
	});

	it('passes only the cookie capability and expected IDs to the application', async () => {
		const app: RecipientApprovedApplicationPort = application(published);
		const { event, deleted } = requestEvent({ idempotencyKey: 'approve-1' });
		const response: Response = await createRecipientApprovedHandler(
			() => app,
			async (): Promise<string> => token
		)(event);

		expect(app.approve).toHaveBeenCalledWith({
			token,
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: recipientId,
			idempotencyKey: 'approve-1'
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('vary')).toBe('Cookie, Origin');
		expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
		const body: unknown = await response.json();
		expect(body).toEqual({
			approved: {
				envelopeId,
				recipientId,
				recipientStatus: 'completed',
				envelopeStatus: 'in_progress',
				approvedAt: '2026-09-11T00:02:00.000Z'
			}
		});
		const serialized: string = JSON.stringify(body);
		expect(serialized).not.toMatch(
			/sentCommitSha|auditEventId|private-audit|skr1_|routingOrder|organizationId/
		);
	});

	it('reports envelope completion when the final approval closes the envelope', async () => {
		const completed: RecipientApprovedResult = {
			outcome: 'published',
			result: {
				...published.result,
				envelopeStatus: 'completed',
				completedAuditEventId: 'completed-1'
			}
		};
		const { event } = requestEvent({ idempotencyKey: 'approve-1' });
		const response: Response = await createRecipientApprovedHandler(
			() => application(completed),
			async (): Promise<string> => token
		)(event);
		const body: unknown = await response.json();
		expect(body).toMatchObject({ approved: { envelopeStatus: 'completed' } });
		const serialized: string = JSON.stringify(body);
		expect(serialized).not.toMatch(/completed-1/);
	});

	it('returns a replay header and still clears the cookie for same-recipient retries', async () => {
		const replayed: RecipientApprovedResult = { ...published, outcome: 'replayed' };
		const { event, deleted } = requestEvent({ idempotencyKey: 'approve-tab-2' });
		const response: Response = await createRecipientApprovedHandler(
			() => application(replayed),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
	});

	it.each([
		['published', published, null],
		['replayed', { ...published, outcome: 'replayed' } as RecipientApprovedResult, 'true']
	])(
		'exchanges the used capability for a read-only receipt cookie on a %s approval',
		async (_label, result: RecipientApprovedResult, replayHeader: string | null) => {
			const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
			const { event, deleted, set } = requestEvent({ idempotencyKey: 'approve-1' });
			const response: Response = await createRecipientApprovedHandler(
				() => application(result),
				async (): Promise<string> => token,
				options
			)(event);

			expect(response.status).toBe(200);
			expect(response.headers.get('idempotency-replayed')).toBe(replayHeader);
			expect(options.resolveReceiptApplication).toHaveBeenCalledWith({
				platform: { env: { DB: {} } }
			});
			expect(set).toHaveBeenCalledWith(
				completedReceiptCookieName(envelopeId),
				'sealed-completed-receipt',
				expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax' })
			);
			expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
		}
	);

	it('keeps the approval a success when the receipt evidence cannot be proven', async () => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const { event, deleted, set } = requestEvent({ idempotencyKey: 'approve-1' });
			const response: Response = await createRecipientApprovedHandler(
				() => application(published),
				async (): Promise<string> => token,
				receiptOptions(null)
			)(event);

			// The approval is durable: reporting failure here would invite an
			// irreversible retry. Only the tokenless reload is lost.
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ approved: { recipientStatus: 'completed' } });
			expect(set).not.toHaveBeenCalled();
			expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
			const logged: string = diagnostic.mock.calls.map(String).join('|');
			expect(logged).toContain('recipient_completed_receipt_exchange_failed');
			expect(logged).not.toContain(token);
		} finally {
			diagnostic.mockRestore();
		}
	});

	it.each([
		['published', published],
		['replayed', { ...published, outcome: 'replayed' } as RecipientApprovedResult]
	])(
		'reports a %s approval as successful when retiring the live cookie itself fails',
		async (_label, result: RecipientApprovedResult) => {
			const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
			try {
				const { event, deleted, set } = requestEvent({ idempotencyKey: 'approve-1' });
				deleted.mockImplementation((): never => {
					throw new Error('cookie serialization failed');
				});

				const response: Response = await createRecipientApprovedHandler(
					() => application(result),
					async (): Promise<string> => token,
					receiptOptions()
				)(event);

				// A durable approval must never surface as a 503 because a
				// Set-Cookie deletion failed after the commit.
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					approved: { recipientStatus: 'completed' }
				});
				expect(set).toHaveBeenCalledWith(
					completedReceiptCookieName(envelopeId),
					'sealed-completed-receipt',
					expect.anything()
				);
				const logged: string = diagnostic.mock.calls.map(String).join('|');
				expect(logged).toContain('recipient_completed_receipt_session_retirement_failed');
				expect(logged).not.toMatch(/skr1_|cookie serialization failed/);
			} finally {
				diagnostic.mockRestore();
			}
		}
	);

	it('grants no receipt cookie for fail-closed 404, 409, and 503 outcomes', async () => {
		for (const [outcome, status] of [
			['not_found', 404],
			['idempotency_conflict', 409],
			['integrity_error', 503]
		] as const) {
			const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
			const { event, deleted, set } = requestEvent({ idempotencyKey: 'approve-1' });
			const response: Response = await createRecipientApprovedHandler(
				() => application({ outcome }),
				async (): Promise<string> => token,
				options
			)(event);
			expect(response.status).toBe(status);
			expect(set).not.toHaveBeenCalled();
			expect(deleted).not.toHaveBeenCalled();
			expect(options.resolveReceiptApplication).not.toHaveBeenCalled();
		}
	});

	it('preserves the cookie for opaque not_found, context_mismatch, and role_not_actionable outcomes', async () => {
		for (const outcome of ['not_found', 'context_mismatch', 'role_not_actionable'] as const) {
			const { event, deleted } = requestEvent({ idempotencyKey: 'approve-a' });
			const response: Response = await createRecipientApprovedHandler(
				() => application({ outcome }),
				async (): Promise<string> => token
			)(event);
			expect(response.status).toBe(404);
			expect(deleted).not.toHaveBeenCalled();
		}
	});

	it('preserves the cookie for an unreadable recipient session', async () => {
		const { event, deleted } = requestEvent({ idempotencyKey: 'approve-1' });
		const response: Response = await createRecipientApprovedHandler(
			() => application(published),
			async (): Promise<string | null> => null
		)(event);
		expect(response.status).toBe(404);
		expect(deleted).not.toHaveBeenCalled();
	});

	it.each([
		[{ outcome: 'idempotency_conflict' } as const, 409],
		[{ outcome: 'audit_conflict' } as const, 409],
		[{ outcome: 'delivery_in_flight' } as const, 409],
		[{ outcome: 'integrity_error' } as const, 503]
	])('maps %j to a fixed RFC 9457 response', async (result, status) => {
		const { event, deleted } = requestEvent({ idempotencyKey: 'approve-1' });
		const response: Response = await createRecipientApprovedHandler(
			() => application(result),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(status);
		expect(response.headers.get('content-type')).toContain('application/problem+json');
		expect(deleted).not.toHaveBeenCalled();
	});

	it.each(['audit_conflict', 'delivery_in_flight'] as const)(
		'sets Retry-After for %s',
		async (outcome) => {
			const { event } = requestEvent({ idempotencyKey: 'approve-1' });
			const response: Response = await createRecipientApprovedHandler(
				() => application({ outcome }),
				async (): Promise<string> => token
			)(event);
			expect(response.headers.get('retry-after')).toBe('1');
		}
	);
});
