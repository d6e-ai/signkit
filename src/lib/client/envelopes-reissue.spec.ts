import { describe, expect, it, vi } from 'vitest';
import {
	createEnvelopeMutationAttempt,
	createEnvelopesClient,
	EnvelopesApiError,
	isAmbiguousEnvelopeMutationFailure
} from './envelopes';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const recipientId = '01900000-0000-7000-8000-000000000002';
const reissuedAt = '2026-09-26T12:00:00.000Z';
const receipt = { envelopeId, recipientId, reissuedAt };
const json = (data: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json', ...headers }
	});
const problem = (status: number): Response =>
	new Response(JSON.stringify({ status, type: `urn:signkit:problem:http-${status}` }), {
		status,
		headers: { 'content-type': 'application/problem+json' }
	});

describe('recipient invitation replacement client', () => {
	it.each([
		[envelopeId, recipientId, `/api/v1/envelopes/${envelopeId}/recipients/${recipientId}/reissue`],
		[
			`${envelopeId}:sub`,
			`${recipientId}/part`,
			`/api/v1/envelopes/${envelopeId}%3Asub/recipients/${recipientId}%2Fpart/reissue`
		]
	])('posts a scoped, encoded recipient request %s', async (envelope, recipient, path) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			json({ reissued: { envelopeId: envelope, recipientId: recipient, reissuedAt } })
		);
		await createEnvelopesClient({ fetch }).reissueRecipientCapability(envelope, recipient, {
			idempotencyKey: 'explicit-key'
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe(path);
		expect(fetch.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			credentials: 'same-origin',
			body: '{}',
			headers: { 'content-type': 'application/json', 'idempotency-key': 'explicit-key' }
		});
	});

	it.each([
		['true', true],
		['false', false],
		['', false]
	])('allowlists receipt and replay flag %s', async (header, replayed) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			json(
				{ reissued: { ...receipt, internalToken: 'fixture-only', auditSequence: 42 } },
				{ 'idempotency-replayed': header }
			)
		);
		const result = await createEnvelopesClient({ fetch }).reissueRecipientCapability(
			envelopeId,
			recipientId
		);
		expect(result).toEqual({ reissued: receipt, replayed });
		expect(
			(fetch.mock.calls[0][1]?.headers as Record<string, string>)['idempotency-key']
		).toBeTruthy();
	});

	it.each([
		{},
		null,
		{ reissued: { ...receipt, envelopeId: '01900000-0000-7000-8000-000000000099' } },
		{ reissued: { ...receipt, recipientId: '01900000-0000-7000-8000-000000000099' } },
		{ reissued: { envelopeId, recipientId } },
		{ reissued: { ...receipt, reissuedAt: 'not-a-date' } }
	])('keeps the actual retry key for malformed successful receipts %#', async (payload) => {
		let sequence = 0;
		const mint = vi.fn(() => `retry-${++sequence}`);
		const attempt = createEnvelopeMutationAttempt(mint);
		const key = attempt.key();
		const client = createEnvelopesClient({
			fetch: vi.fn<typeof globalThis.fetch>(async () => json(payload))
		});
		await expect(
			client.reissueRecipientCapability(envelopeId, recipientId, { idempotencyKey: key })
		).rejects.toSatisfy((cause: unknown) => {
			expect(cause).toBeInstanceOf(EnvelopesApiError);
			expect((cause as EnvelopesApiError).status).toBe(502);
			expect(isAmbiguousEnvelopeMutationFailure(cause)).toBe(true);
			attempt.failed(cause);
			return true;
		});
		expect(attempt.key()).toBe(key);
		expect(mint).toHaveBeenCalledTimes(1);
	});

	it.each([0, 408, 429, 500, 503])(
		'retries ambiguous status %s with the same on-wire key',
		async (status) => {
			let sequence = 0;
			const attempt = createEnvelopeMutationAttempt(() => `retry-${++sequence}`);
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockImplementationOnce(async () => {
					if (status === 0) throw new TypeError('Network');
					return problem(status);
				})
				.mockResolvedValueOnce(json({ reissued: receipt }, { 'idempotency-replayed': 'true' }));
			const client = createEnvelopesClient({ fetch });
			const first = attempt.key();
			await expect(
				client.reissueRecipientCapability(envelopeId, recipientId, { idempotencyKey: first })
			).rejects.toSatisfy((cause: unknown) => {
				expect(isAmbiguousEnvelopeMutationFailure(cause)).toBe(true);
				attempt.failed(cause);
				return true;
			});
			expect(attempt.key()).toBe(first);
			const replay = await client.reissueRecipientCapability(envelopeId, recipientId, {
				idempotencyKey: attempt.key()
			});
			expect(replay.replayed).toBe(true);
			expect(
				fetch.mock.calls.map(
					([, init]) => (init?.headers as Record<string, string>)['idempotency-key']
				)
			).toEqual([first, first]);
			attempt.succeeded();
			expect(attempt.key()).not.toBe(first);
		}
	);

	it.each([400, 403, 404, 409])(
		'uses a fresh key after authoritative rejection %s',
		async (status) => {
			let sequence = 0;
			const attempt = createEnvelopeMutationAttempt(() => `key-${++sequence}`);
			const first = attempt.key();
			const client = createEnvelopesClient({
				fetch: vi.fn<typeof globalThis.fetch>(async () => problem(status))
			});
			await expect(
				client.reissueRecipientCapability(envelopeId, recipientId, { idempotencyKey: first })
			).rejects.toSatisfy((cause: unknown) => {
				expect(isAmbiguousEnvelopeMutationFailure(cause)).toBe(false);
				attempt.failed(cause);
				return true;
			});
			expect(attempt.key()).not.toBe(first);
		}
	);
});
