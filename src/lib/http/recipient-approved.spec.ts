import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientApprovedApplicationPort,
	RecipientApprovedResult
} from '$lib/application/signing/recipient-approved';
import { RECIPIENT_SESSION_COOKIE } from '$lib/server/recipient-session';
import {
	createRecipientApprovedHandler,
	type RecipientApprovedApplicationResolver
} from './recipient-approved';

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
	const request = new Request('https://signkit.example/api/v1/signing/approve', {
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

describe('recipient approved HTTP handler', () => {
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
		expect(deleted).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, { path: '/' });
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
		expect(deleted).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, { path: '/' });
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
