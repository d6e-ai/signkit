import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientSignedApplicationPort,
	RecipientSignedResult
} from '$lib/application/signing/recipient-signed';
import { RECIPIENT_SESSION_COOKIE } from '$lib/server/recipient-session';
import {
	createRecipientSignedHandler,
	type RecipientSignedApplicationResolver
} from './recipient-signed';

const envelopeId: string = '00000000-0000-8000-a000-000000000001';
const recipientId: string = '00000000-0000-8000-a000-000000000002';
const fieldId: string = '00000000-0000-8000-a000-000000000003';
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
): { event: RequestEvent; deleted: ReturnType<typeof vi.fn> } {
	const headers: Headers = new Headers({ 'content-type': 'application/json' });
	if (options.origin !== null) headers.set('origin', options.origin ?? 'https://signkit.example');
	if (options.idempotencyKey !== undefined) {
		headers.set('idempotency-key', options.idempotencyKey);
	}
	const deleted = vi.fn();
	const cookie: string | undefined = options.cookie ?? 'sealed-session';
	const cookies = {
		get: vi.fn((name: string): string | undefined =>
			name === RECIPIENT_SESSION_COOKIE ? cookie : undefined
		),
		delete: deleted
	} as unknown as Cookies;
	const request = new Request('https://signkit.example/api/v1/signing/sign', {
		method: 'POST',
		headers,
		body: JSON.stringify(options.body ?? commandBody)
	});
	return {
		event: {
			cookies,
			platform: { env: { DB: {} as D1Database } },
			request,
			url: new URL(request.url)
		} as unknown as RequestEvent,
		deleted
	};
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

describe('recipient signed HTTP handler', () => {
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
		expect(deleted).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, { path: '/' });
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
			fieldId: `00000000-0000-8000-a000-${index.toString(16).padStart(12, '0')}`,
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
		expect(deleted).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, { path: '/' });
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
