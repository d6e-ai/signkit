import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	AuthorizedRecipientCompletedReceipt,
	RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
import type {
	RecipientSignedApplicationPort,
	RecipientSignedResult
} from '$lib/application/signing/recipient-signed';
import { completedReceiptCookieName } from '$lib/server/completed-receipt-session';
import { recipientSessionCookieName } from '$lib/server/recipient-session';
import type { RecipientCompletedReceiptHandlerOptions } from './recipient-completed-receipt';
import {
	createRecipientSignedHandler,
	type RecipientSignedApplicationResolver
} from './recipient-signed';
import { createRecipientRequestEvent } from './recipient-request-event-test-support';

const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';
const fieldId: string = '01910000-0000-7000-8000-000000000003';
const token: string = `skr1_${'A'.repeat(43)}`;
const commandBody = {
	envelopeId,
	recipientId,
	expectedFieldGeneration: 1,
	values: [{ fieldId, value: 'Jane Doe' }]
};

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
		pathname: '/api/v1/signing/sign',
		defaultBody: commandBody,
		...options
	});
	const set = vi.fn();
	cookies.set = set;
	return { event, deleted, set };
}

function application(result: RecipientSignedResult): RecipientSignedApplicationPort {
	return { sign: vi.fn(async (): Promise<RecipientSignedResult> => result) };
}

const published: RecipientSignedResult = {
	outcome: 'published',
	result: {
		envelopeId,
		recipientId,
		recipientRole: 'signer',
		routingOrder: 1,
		sentCommitSha: 'a'.repeat(40),
		envelopeStatus: 'in_progress',
		signedAt: '2026-09-11T00:02:00.000Z',
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
		action: 'signed',
		completedAt: '2026-09-11T00:02:00.000Z',
		envelopeStatus: 'in_progress',
		envelopeCompletedByThisAction: false,
		locale: 'en'
	},
	locator: {
		envelopeId,
		recipientId,
		idempotencyKey: 'sign-1',
		capabilityHash: 'b'.repeat(64),
		action: 'signed',
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

describe('recipient signed HTTP handler', () => {
	it('signs with an explicit browserless capability without clearing browser cookies', async () => {
		const app: RecipientSignedApplicationPort = application(published);
		const unseal = vi.fn(async (): Promise<string> => token);
		const { event, cookies, deleted } = createRecipientRequestEvent({
			pathname: '/api/v1/recipient/sign',
			defaultBody: commandBody,
			origin: null,
			authorization: `Bearer ${token}`,
			idempotencyKey: 'sign-cli-1'
		});
		const set = vi.fn();
		cookies.set = set;
		const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
		const response: Response = await createRecipientSignedHandler(
			() => app,
			unseal,
			options,
			'bearer'
		)(event);
		expect(response.status).toBe(200);
		expect(app.sign).toHaveBeenCalledWith(
			expect.objectContaining({ token, expectedFieldGeneration: 1, values: commandBody.values })
		);
		expect(cookies.get).not.toHaveBeenCalled();
		expect(deleted).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		expect(options.resolveReceiptApplication).not.toHaveBeenCalled();
		expect(unseal).not.toHaveBeenCalled();
		expect(JSON.stringify(await response.json())).not.toContain(token);
	});

	it('rejects a sender API key even when an ambient signing cookie exists', async () => {
		const { event } = createRecipientRequestEvent({
			pathname: '/api/v1/recipient/sign',
			defaultBody: commandBody,
			origin: null,
			authorization: `Bearer signkit_${'A'.repeat(43)}`,
			idempotencyKey: 'sign-cli-2'
		});
		const getReader = vi.spyOn(event.request.body!, 'getReader');
		const app: RecipientSignedApplicationPort = application(published);
		const response: Response = await createRecipientSignedHandler(
			() => app,
			async (): Promise<string> => token,
			undefined,
			'bearer'
		)(event);
		expect(response.status).toBe(404);
		expect(app.sign).not.toHaveBeenCalled();
		expect(getReader).not.toHaveBeenCalled();
	});

	it('rejects cross-origin and origin-less POSTs before reading the cookie', async () => {
		for (const origin of ['https://attacker.example', null]) {
			const { event } = requestEvent({ origin, idempotencyKey: 'sign-1' });
			const unseal = vi.fn(async (): Promise<string> => token);
			const resolver: RecipientSignedApplicationResolver = vi.fn(() => application(published));
			const response: Response = await createRecipientSignedHandler(resolver, unseal)(event);
			expect(response.status).toBe(403);
			expect(unseal).not.toHaveBeenCalled();
			expect(resolver).not.toHaveBeenCalled();
		}
	});

	it('requires a bounded idempotency key, expected field generation, and strict IDs', async () => {
		for (const options of [
			{},
			{ idempotencyKey: 'sign-1', body: { ...commandBody, extra: true } },
			{
				idempotencyKey: 'sign-1',
				body: {
					envelopeId: 'not-a-uuid',
					recipientId,
					expectedFieldGeneration: 1,
					values: commandBody.values
				}
			},
			{
				idempotencyKey: 'sign-1',
				body: { envelopeId, recipientId, values: commandBody.values }
			}
		]) {
			const { event } = requestEvent(options);
			const response: Response = await createRecipientSignedHandler(
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
			const response: Response = await createRecipientSignedHandler(
				() => application(published),
				unseal
			)(event);
			expect(response.status).toBe(400);
			expect(unseal).not.toHaveBeenCalled();
		}
	);

	it('rejects a non-JSON content type before reading the cookie', async () => {
		const { event } = requestEvent({ idempotencyKey: 'sign-1' });
		(event.request.headers as Headers).set('content-type', 'text/plain');
		const unseal = vi.fn(async (): Promise<string> => token);
		const response: Response = await createRecipientSignedHandler(
			() => application(published),
			unseal
		)(event);
		expect(response.status).toBe(415);
		expect(unseal).not.toHaveBeenCalled();
	});

	it('passes the cookie capability, expected IDs, and field generation to the application', async () => {
		const app: RecipientSignedApplicationPort = application(published);
		const { event, deleted } = requestEvent({ idempotencyKey: 'sign-1' });
		const response: Response = await createRecipientSignedHandler(
			() => app,
			async (): Promise<string> => token
		)(event);

		expect(app.sign).toHaveBeenCalledWith({
			token,
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: recipientId,
			expectedFieldGeneration: 1,
			idempotencyKey: 'sign-1',
			values: [{ fieldId, value: 'Jane Doe' }]
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('vary')).toBe('Cookie, Origin');
		expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
		const body: unknown = await response.json();
		expect(body).toEqual({
			signed: {
				envelopeId,
				recipientId,
				recipientStatus: 'completed',
				envelopeStatus: 'in_progress',
				signedAt: '2026-09-11T00:02:00.000Z'
			}
		});
		const serialized: string = JSON.stringify(body);
		expect(serialized).not.toMatch(
			/sentCommitSha|auditEventId|private-audit|skr1_|Jane Doe|Your signature|routingOrder|organizationId/
		);
	});

	it('accepts the exact empty field set for a signer without assigned fields', async () => {
		const app: RecipientSignedApplicationPort = application(published);
		const { event } = requestEvent({
			idempotencyKey: 'sign-empty',
			body: { ...commandBody, values: [] }
		});
		const response: Response = await createRecipientSignedHandler(
			() => app,
			async (): Promise<string> => token
		)(event);

		expect(response.status).toBe(200);
		expect(app.sign).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: 'sign-empty', values: [] })
		);
	});

	it('accepts the largest schema-valid text field set without tripping the body cap', async () => {
		const values = Array.from({ length: 50 }, (_, index: number) => ({
			fieldId: `01910000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
			value: '\u0000'.repeat(4000)
		}));
		const body = { ...commandBody, values };
		expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(1024 * 1024);
		const app: RecipientSignedApplicationPort = application(published);
		const { event } = requestEvent({
			idempotencyKey: 'sign-max-fields',
			body
		});
		const response: Response = await createRecipientSignedHandler(
			() => app,
			async (): Promise<string> => token
		)(event);

		expect(response.status).toBe(200);
		expect(app.sign).toHaveBeenCalledWith(expect.objectContaining({ values }));
	});

	it('returns a replay header and still clears the cookie for same-recipient retries', async () => {
		const replayed: RecipientSignedResult = { ...published, outcome: 'replayed' };
		const { event, deleted } = requestEvent({ idempotencyKey: 'sign-tab-2' });
		const response: Response = await createRecipientSignedHandler(
			() => application(replayed),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(deleted).toHaveBeenCalledWith(recipientSessionCookieName(envelopeId), { path: '/' });
	});

	it.each([
		['published', published, null],
		['replayed', { ...published, outcome: 'replayed' } as RecipientSignedResult, 'true']
	])(
		'exchanges the used capability for a read-only receipt cookie on a %s sign',
		async (_label, result: RecipientSignedResult, replayHeader: string | null) => {
			const options: RecipientCompletedReceiptHandlerOptions = receiptOptions();
			const { event, deleted, set } = requestEvent({ idempotencyKey: 'sign-1' });
			const response: Response = await createRecipientSignedHandler(
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

	it('keeps the sign a success when the receipt evidence cannot be proven', async () => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const { event, deleted, set } = requestEvent({ idempotencyKey: 'sign-1' });
			const response: Response = await createRecipientSignedHandler(
				() => application(published),
				async (): Promise<string> => token,
				receiptOptions(null)
			)(event);

			// The signature is durable: reporting failure here would invite an
			// irreversible retry. Only the tokenless reload is lost.
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ signed: { recipientStatus: 'completed' } });
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
		['replayed', { ...published, outcome: 'replayed' } as RecipientSignedResult]
	])(
		'reports a %s sign as successful when retiring the live cookie itself fails',
		async (_label, result: RecipientSignedResult) => {
			const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
			try {
				const { event, deleted, set } = requestEvent({ idempotencyKey: 'sign-1' });
				deleted.mockImplementation((): never => {
					throw new Error('cookie serialization failed');
				});

				const response: Response = await createRecipientSignedHandler(
					() => application(result),
					async (): Promise<string> => token,
					receiptOptions()
				)(event);

				// A durable signature must never surface as a 503 because a
				// Set-Cookie deletion failed after the commit.
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ signed: { recipientStatus: 'completed' } });
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
			const { event, deleted, set } = requestEvent({ idempotencyKey: 'sign-1' });
			const response: Response = await createRecipientSignedHandler(
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
			const { event, deleted } = requestEvent({ idempotencyKey: 'sign-a' });
			const response: Response = await createRecipientSignedHandler(
				() => application({ outcome }),
				async (): Promise<string> => token
			)(event);
			expect(response.status).toBe(404);
			expect(deleted).not.toHaveBeenCalled();
		}
	});

	it.each([
		[{ outcome: 'idempotency_conflict' } as const, 409],
		[{ outcome: 'field_generation_conflict' } as const, 409],
		[{ outcome: 'invalid_field' } as const, 400],
		[{ outcome: 'incomplete_field_set' } as const, 400],
		[{ outcome: 'missing_required_value' } as const, 400],
		[{ outcome: 'audit_conflict' } as const, 409],
		[{ outcome: 'delivery_in_flight' } as const, 409],
		[{ outcome: 'integrity_error' } as const, 503]
	])('maps %j to a fixed RFC 9457 response', async (result, status) => {
		const { event, deleted } = requestEvent({ idempotencyKey: 'sign-1' });
		const response: Response = await createRecipientSignedHandler(
			() => application(result),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(status);
		expect(response.headers.get('content-type')).toContain('application/problem+json');
		expect(deleted).not.toHaveBeenCalled();
	});

	it('sets Retry-After only for retryable terminal conflicts', async () => {
		for (const outcome of ['audit_conflict', 'delivery_in_flight'] as const) {
			const response = await createRecipientSignedHandler(
				() => application({ outcome }),
				async (): Promise<string> => token
			)(requestEvent({ idempotencyKey: 'sign-1' }).event);
			expect(response.headers.get('retry-after')).toBe('1');
		}

		const stale = await createRecipientSignedHandler(
			() => application({ outcome: 'field_generation_conflict' }),
			async (): Promise<string> => token
		)(requestEvent({ idempotencyKey: 'sign-1' }).event);
		expect(stale.headers.get('retry-after')).toBeNull();
	});
});
