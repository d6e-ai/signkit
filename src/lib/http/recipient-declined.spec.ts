import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientDeclinedApplicationPort,
	RecipientDeclinedResult
} from '$lib/application/signing/recipient-declined';
import { RECIPIENT_SESSION_COOKIE } from '$lib/server/recipient-session';
import {
	createRecipientDeclinedHandler,
	type RecipientDeclinedApplicationResolver
} from './recipient-declined';

const envelopeId: string = '00000000-0000-8000-a000-000000000001';
const recipientId: string = '00000000-0000-8000-a000-000000000002';
const token: string = `skr1_${'A'.repeat(43)}`;

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
	const request = new Request('https://signkit.example/api/v1/signing/decline', {
		method: 'POST',
		headers,
		body: JSON.stringify(options.body ?? { envelopeId, recipientId })
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
		const { event, deleted } = requestEvent({ idempotencyKey: 'decline-1' });
		const response: Response = await createRecipientDeclinedHandler(
			() => app,
			async (): Promise<string> => token
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
		expect(deleted).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, { path: '/' });
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
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(deleted).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, { path: '/' });
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
			expect(deleted).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, { path: '/' });
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
