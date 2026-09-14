import { describe, expect, it, vi } from 'vitest';
import { createRecipientSignController, validateSignedReceipt } from './[envelopeId]/+page.svelte';

const base = {
	envelopeId: '01910000-0000-7000-8000-000000000001',
	recipientId: '01910000-0000-7000-8000-000000000002',
	expectedFieldGeneration: 1,
	role: 'signer',
	pageState: 'active',
	recipientStatus: 'viewed'
};
const fieldId: string = '01910000-0000-7000-8000-000000000003';
const values = [{ fieldId, value: 'Jane Doe' }];

function successResponse(
	envelopeStatus: 'in_progress' | 'completed' = 'in_progress',
	replayed = false
): Response {
	return new Response(
		JSON.stringify({
			signed: {
				envelopeId: base.envelopeId,
				recipientId: base.recipientId,
				recipientStatus: 'completed',
				envelopeStatus,
				signedAt: '2026-09-11T00:00:00.000Z'
			}
		}),
		{
			status: 200,
			headers: replayed ? { 'idempotency-replayed': 'true' } : undefined
		}
	);
}

describe('recipient sign client controller', () => {
	it('allows only an active, viewed signer', async () => {
		for (const options of [
			{ ...base, role: 'approver' },
			{ ...base, role: 'viewer' },
			{ ...base, role: 'prefill' },
			{ ...base, recipientStatus: 'pending' },
			{ ...base, pageState: 'invalid' }
		]) {
			const fetch = vi.fn();
			const controller = createRecipientSignController({ ...options, fetch });
			await controller.confirmSign(values);
			expect(fetch).not.toHaveBeenCalled();
			expect(controller.getIdempotencyKey()).toBeNull();
		}
	});

	it('posts expected IDs, field generation, and values with same-origin credentials', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => successResponse());
		const controller = createRecipientSignController({
			...base,
			fetch,
			newIdempotencyKey: () => 'sign-key'
		});

		await controller.confirmSign(values);

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/api/v1/signing/sign');
		expect(init).toMatchObject({
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'content-type': 'application/json',
				'idempotency-key': 'sign-key'
			}
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			envelopeId: base.envelopeId,
			recipientId: base.recipientId,
			expectedFieldGeneration: 1,
			values
		});
		expect(controller.getReceipt()).toMatchObject({
			recipientStatus: 'completed',
			envelopeStatus: 'in_progress'
		});
	});

	it('reuses one idempotency key and the first value snapshot across transient retries', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockResolvedValueOnce(successResponse());
		const controller = createRecipientSignController({
			...base,
			fetch,
			newIdempotencyKey: () => 'stable-sign-key'
		});

		await controller.confirmSign(values);
		await controller.confirmSign([{ fieldId, value: 'Changed after ambiguous response' }]);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(
			fetch.mock.calls.map(
				(call) => (call[1]?.headers as Record<string, string>)['idempotency-key']
			)
		).toEqual(['stable-sign-key', 'stable-sign-key']);
		expect(fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).values)).toEqual([
			values,
			values
		]);
		expect(controller.getStatus()).toBe('success');
	});

	it('records the replay header only after an exact receipt', async () => {
		const onSuccess = vi.fn();
		const controller = createRecipientSignController({
			...base,
			fetch: async () => successResponse('completed', true),
			onSuccess
		});

		await controller.confirmSign(values);

		expect(controller.isReplayed()).toBe(true);
		expect(controller.getReceipt()).toMatchObject({ replayed: true, envelopeStatus: 'completed' });
		expect(onSuccess).toHaveBeenCalledWith(
			expect.objectContaining({ replayed: true, receipt: expect.any(Object) })
		);
	});

	it('rejects malformed or over-broad success receipts', async () => {
		const response = new Response(
			JSON.stringify({
				signed: {
					envelopeId: base.envelopeId,
					recipientId: base.recipientId,
					recipientStatus: 'completed',
					envelopeStatus: 'in_progress',
					signedAt: '2026-09-11T00:00:00.000Z',
					value: 'Jane Doe'
				}
			}),
			{ status: 200 }
		);
		await expect(
			validateSignedReceipt(response, base.envelopeId, base.recipientId)
		).resolves.toBeNull();
	});

	it('makes missing access and definite client failures terminal while server failures stay retryable', async () => {
		for (const status of [403, 404, 409]) {
			const terminal = createRecipientSignController({
				...base,
				fetch: async () => new Response('{}', { status })
			});
			await terminal.confirmSign(values);
			expect(terminal.getStatus()).toBe('terminal_failure');
		}

		for (const status of [408, 429, 503]) {
			const transient = createRecipientSignController({
				...base,
				fetch: async () => new Response('{}', { status, headers: { 'retry-after': '1' } })
			});
			await transient.confirmSign(values);
			expect(transient.getStatus()).toBe(
				status === 503 ? 'transient_failure' : 'transient_failure'
			);
		}
	});

	it('treats a field-generation conflict as terminal because the page is stale', async () => {
		const controller = createRecipientSignController({
			...base,
			fetch: async () => new Response('{}', { status: 409 })
		});
		await controller.confirmSign(values);
		expect(controller.getStatus()).toBe('terminal_failure');
	});

	it.each([400, 413])(
		'treats %i as editable validation failure and mints a new command after correction',
		async (status: number) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(new Response('{}', { status }))
				.mockResolvedValueOnce(successResponse());
			const keys: string[] = ['invalid-sign-key', 'corrected-sign-key'];
			const controller = createRecipientSignController({
				...base,
				fetch,
				newIdempotencyKey: () => keys.shift() ?? 'unexpected-key'
			});

			await controller.confirmSign(values);
			expect(controller.getStatus()).toBe('validation_failure');
			expect(controller.getIdempotencyKey()).toBeNull();

			const corrected = [{ fieldId, value: 'Corrected value' }];
			await controller.confirmSign(corrected);
			expect(controller.getStatus()).toBe('success');
			expect(
				fetch.mock.calls.map(
					(call) => (call[1]?.headers as Record<string, string>)['idempotency-key']
				)
			).toEqual(['invalid-sign-key', 'corrected-sign-key']);
			expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).values).toEqual(corrected);
		}
	);
});
