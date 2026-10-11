import { describe, expect, it, vi } from 'vitest';
import {
	createEnvelopeMutationAttempt,
	createEnvelopesClient,
	EnvelopesApiError,
	isAmbiguousEnvelopeMutationFailure
} from './envelopes';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const recipientId = '01900000-0000-7000-8000-000000000002';
const deliveryId = '01900000-0000-7000-8000-000000000003';
const generation = 1;
const accessExpiresAt = '2026-11-10T12:00:00.000Z';
const reissuedAt = '2026-10-11T12:00:00.000Z';
const receipt = { envelopeId, recipientId, deliveryId, generation, accessExpiresAt, reissuedAt };
const command = {
	expectedDeliveryId: 'predecessor-delivery-1',
	expectedAttempts: 10,
	expectedFailedAt: '2026-10-11T00:00:00.000Z',
	expectedErrorCode: 'completion_delivery_attempts_exhausted'
};
const json = (data: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json', ...headers }
	});
const problem = (status: number): Response =>
	new Response(JSON.stringify({ status, type: `urn:signkit:problem:http-${status}` }), {
		status,
		headers: { 'content-type': 'application/problem+json' }
	});

describe('completion deliveries read', () => {
	it('GETs the scoped, encoded completion-deliveries path', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ completionDeliveries: [] }));
		await createEnvelopesClient({ fetch }).completionDeliveries(`${envelopeId}:sub`);
		expect(fetch.mock.calls[0][0]).toBe(
			`/api/v1/envelopes/${envelopeId}%3Asub/completion-deliveries`
		);
		expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET' });
	});

	it('returns the allowlisted rows verbatim', async () => {
		const rows = [
			{
				deliveryId,
				recipientId,
				recipientRole: 'signer',
				generation,
				status: 'failed',
				attempts: 10,
				accessExpiresAt,
				accessRevokedAt: reissuedAt,
				deliveredAt: null,
				failedAt: command.expectedFailedAt,
				errorCode: command.expectedErrorCode,
				eligibleForReissue: true
			}
		];
		const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ completionDeliveries: rows }));
		const result = await createEnvelopesClient({ fetch }).completionDeliveries(envelopeId);
		expect(result).toEqual(rows);
	});
});

describe('completion access reissue client', () => {
	it.each([
		[
			envelopeId,
			recipientId,
			`/api/v1/envelopes/${envelopeId}/recipients/${recipientId}/completion-access/reissue`
		],
		[
			`${envelopeId}:sub`,
			`${recipientId}/part`,
			`/api/v1/envelopes/${envelopeId}%3Asub/recipients/${recipientId}%2Fpart/completion-access/reissue`
		]
	])('posts a scoped, encoded reissue command %s', async (envelope, recipient, path) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			json({
				completionAccessReissue: { ...receipt, envelopeId: envelope, recipientId: recipient }
			})
		);
		await createEnvelopesClient({ fetch }).reissueCompletionAccess(envelope, recipient, command, {
			idempotencyKey: 'explicit-key'
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe(path);
		expect(fetch.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			credentials: 'same-origin',
			body: JSON.stringify({ grantAccess: true, ...command }),
			headers: { 'content-type': 'application/json', 'idempotency-key': 'explicit-key' }
		});
	});

	it.each([
		['true', true],
		['false', false],
		['', false]
	])('allowlists the receipt and the replay flag %s', async (header, replayed) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			json(
				{
					completionAccessReissue: {
						...receipt,
						sealedToken: 'fixture-only',
						auditSequence: 42
					}
				},
				{ 'idempotency-replayed': header }
			)
		);
		const result = await createEnvelopesClient({ fetch }).reissueCompletionAccess(
			envelopeId,
			recipientId,
			command
		);
		expect(result).toEqual({ completionAccessReissue: receipt, replayed });
		expect(
			(fetch.mock.calls[0][1]?.headers as Record<string, string>)['idempotency-key']
		).toBeTruthy();
	});

	it.each([
		{},
		null,
		{ completionAccessReissue: { ...receipt, envelopeId: '01900000-0000-7000-8000-000000000099' } },
		{
			completionAccessReissue: { ...receipt, recipientId: '01900000-0000-7000-8000-000000000099' }
		},
		{ completionAccessReissue: { envelopeId, recipientId } },
		{ completionAccessReissue: { ...receipt, generation: 'one' } },
		{ completionAccessReissue: { ...receipt, accessExpiresAt: 'not-a-date' } },
		{ completionAccessReissue: { ...receipt, reissuedAt: 'not-a-date' } }
	])('keeps the actual retry key for malformed successful receipts %#', async (payload) => {
		let sequence = 0;
		const mint = vi.fn(() => `retry-${++sequence}`);
		const attempt = createEnvelopeMutationAttempt(mint);
		const key = attempt.key();
		const client = createEnvelopesClient({
			fetch: vi.fn<typeof globalThis.fetch>(async () => json(payload))
		});
		await expect(
			client.reissueCompletionAccess(envelopeId, recipientId, command, { idempotencyKey: key })
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
		'retries ambiguous status %s with the same on-wire key and the same command body',
		async (status) => {
			let sequence = 0;
			const attempt = createEnvelopeMutationAttempt(() => `retry-${++sequence}`);
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockImplementationOnce(async () => {
					if (status === 0) throw new TypeError('Network');
					return problem(status);
				})
				.mockResolvedValueOnce(
					json({ completionAccessReissue: receipt }, { 'idempotency-replayed': 'true' })
				);
			const client = createEnvelopesClient({ fetch });
			const first = attempt.key();
			await expect(
				client.reissueCompletionAccess(envelopeId, recipientId, command, { idempotencyKey: first })
			).rejects.toSatisfy((cause: unknown) => {
				expect(isAmbiguousEnvelopeMutationFailure(cause)).toBe(true);
				attempt.failed(cause);
				return true;
			});
			expect(attempt.key()).toBe(first);
			const replay = await client.reissueCompletionAccess(envelopeId, recipientId, command, {
				idempotencyKey: attempt.key()
			});
			expect(replay.replayed).toBe(true);
			expect(
				fetch.mock.calls.map(
					([, init]) => (init?.headers as Record<string, string>)['idempotency-key']
				)
			).toEqual([first, first]);
			expect(fetch.mock.calls.map(([, init]) => init?.body as string)).toEqual([
				JSON.stringify({ grantAccess: true, ...command }),
				JSON.stringify({ grantAccess: true, ...command })
			]);
			attempt.succeeded();
			expect(attempt.key()).not.toBe(first);
		}
	);

	it.each([400, 403, 404, 409])(
		'uses a fresh key after authoritative rejection %s, including a changed-body idempotency conflict',
		async (status) => {
			let sequence = 0;
			const attempt = createEnvelopeMutationAttempt(() => `key-${++sequence}`);
			const first = attempt.key();
			const client = createEnvelopesClient({
				fetch: vi.fn<typeof globalThis.fetch>(async () => problem(status))
			});
			await expect(
				client.reissueCompletionAccess(envelopeId, recipientId, command, { idempotencyKey: first })
			).rejects.toSatisfy((cause: unknown) => {
				expect(isAmbiguousEnvelopeMutationFailure(cause)).toBe(false);
				attempt.failed(cause);
				return true;
			});
			expect(attempt.key()).not.toBe(first);
		}
	);
});
