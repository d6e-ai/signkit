import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientViewedApplicationPort,
	RecipientViewedResult
} from '$lib/application/signing/recipient-viewed';
import {
	createRecipientViewedHandler,
	type RecipientViewedApplicationResolver
} from './recipient-viewed';
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
): { event: RequestEvent; deleted: ReturnType<typeof vi.fn> } {
	return createRecipientRequestEvent({
		pathname: '/api/v1/signing/viewed',
		defaultBody: { envelopeId, recipientId },
		...options
	});
}

function application(result: RecipientViewedResult): RecipientViewedApplicationPort {
	return { view: vi.fn(async (): Promise<RecipientViewedResult> => result) };
}

const published: RecipientViewedResult = {
	outcome: 'published',
	result: {
		envelopeId,
		recipientId,
		recipientRole: 'signer',
		routingOrder: 1,
		sentCommitSha: 'a'.repeat(40),
		envelopeStatus: 'in_progress',
		viewedAt: '2026-09-11T00:02:00.000Z',
		auditEventId: 'private-audit-id'
	}
};

describe('recipient viewed HTTP handler', () => {
	it('rejects cross-origin and origin-less POSTs before reading the cookie', async () => {
		for (const origin of ['https://attacker.example', null]) {
			const { event } = requestEvent({ origin, idempotencyKey: 'view-1' });
			const unseal = vi.fn(async (): Promise<string> => token);
			const resolver: RecipientViewedApplicationResolver = vi.fn(() => application(published));
			const response: Response = await createRecipientViewedHandler(resolver, unseal)(event);
			expect(response.status).toBe(403);
			expect(unseal).not.toHaveBeenCalled();
			expect(resolver).not.toHaveBeenCalled();
		}
	});

	it('requires a bounded idempotency key and strict expected IDs', async () => {
		for (const options of [
			{},
			{ idempotencyKey: 'view-1', body: { envelopeId, recipientId, extra: true } },
			{ idempotencyKey: 'view-1', body: { envelopeId: 'not-a-uuid', recipientId } }
		]) {
			const { event } = requestEvent(options);
			const response: Response = await createRecipientViewedHandler(
				() => application(published),
				async (): Promise<string> => token
			)(event);
			expect(response.status).toBe(400);
		}
	});

	it('passes only the cookie capability and expected IDs to the application', async () => {
		const app: RecipientViewedApplicationPort = application(published);
		const { event } = requestEvent({ idempotencyKey: 'view-1' });
		const response: Response = await createRecipientViewedHandler(
			() => app,
			async (): Promise<string> => token
		)(event);

		expect(app.view).toHaveBeenCalledWith({
			token,
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: recipientId,
			idempotencyKey: 'view-1'
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('vary')).toBe('Cookie, Origin');
		const serialized: string = JSON.stringify(await response.json());
		expect(serialized).not.toMatch(/sentCommitSha|auditEventId|private-audit|skr1_/);
	});

	it('returns a replay header for same-recipient tab retries', async () => {
		const replayed: RecipientViewedResult = { ...published, outcome: 'replayed' };
		const { event } = requestEvent({ idempotencyKey: 'view-tab-2' });
		const response: Response = await createRecipientViewedHandler(
			() => application(replayed),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
	});

	it('does not clear recipient B cookie when stale tab A IDs mismatch', async () => {
		const { event, deleted } = requestEvent({ idempotencyKey: 'view-a' });
		const response: Response = await createRecipientViewedHandler(
			() => application({ outcome: 'context_mismatch' }),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(404);
		expect(deleted).not.toHaveBeenCalled();
	});

	it('does not clear recipient session on inactive or unreadable session (overwrite-only)', async () => {
		for (const mode of ['inactive', 'unreadable'] as const) {
			const { event, deleted } = requestEvent({ idempotencyKey: 'view-1' });
			const response: Response = await createRecipientViewedHandler(
				() => application({ outcome: 'not_found' }),
				async (): Promise<string | null> => (mode === 'unreadable' ? null : token)
			)(event);
			expect(response.status).toBe(404);
			expect(deleted).not.toHaveBeenCalled();
		}
	});

	it('returns 200 with continuation property when view outcome is continued', async () => {
		const continued: RecipientViewedResult = { ...published, outcome: 'continued' };
		const { event, deleted } = requestEvent({ idempotencyKey: 'view-tab-reissued' });
		const response: Response = await createRecipientViewedHandler(
			() => application(continued),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBeNull();
		const body = (await response.json()) as { viewed: { continuation?: boolean } };
		expect(body.viewed.continuation).toBe(true);
		expect(deleted).not.toHaveBeenCalled();
	});

	it.each([
		[{ outcome: 'idempotency_conflict' } as const, 409],
		[{ outcome: 'audit_conflict' } as const, 409],
		[{ outcome: 'integrity_error' } as const, 503]
	])('maps %j to a fixed RFC 9457 response', async (result, status) => {
		const { event } = requestEvent({ idempotencyKey: 'view-1' });
		const response: Response = await createRecipientViewedHandler(
			() => application(result),
			async (): Promise<string> => token
		)(event);
		expect(response.status).toBe(status);
		expect(response.headers.get('content-type')).toContain('application/problem+json');
	});
});
