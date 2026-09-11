import { describe, expect, it, vi } from 'vitest';
import { createRecipientDeclineController, isPermanentClientFailure } from './+page.svelte';

const base = {
	envelopeId: '00000000-0000-8000-a000-000000000001',
	recipientId: '00000000-0000-8000-a000-000000000002',
	role: 'signer',
	pageState: 'active'
};

function successResponse(): Response {
	return new Response(
		JSON.stringify({
			declined: {
				envelopeId: base.envelopeId,
				recipientId: base.recipientId,
				recipientStatus: 'declined',
				envelopeStatus: 'declined',
				declinedAt: '2026-09-11T00:00:00.000Z'
			}
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

describe('recipient decline client controller', () => {
	it('does not send requests for inactive page states or non-actionable roles', async () => {
		for (const options of [
			{ ...base, pageState: 'invalid' },
			{ ...base, pageState: 'unavailable' },
			{ ...base, role: 'viewer' },
			{ ...base, role: 'prefill' }
		]) {
			const fetch = vi.fn();
			const randomUUID = vi.fn(() => 'decline-key');
			const controller = createRecipientDeclineController({
				...options,
				fetch,
				randomUUID
			});

			await controller.confirmDecline();

			expect(fetch).not.toHaveBeenCalled();
			expect(randomUUID).not.toHaveBeenCalled();
			expect(controller.getStatus()).toBe('idle');
			expect(controller.isInFlight()).toBe(false);
		}
	});

	it('does not send any request before explicit confirm', () => {
		const fetch = vi.fn();
		const randomUUID = vi.fn(() => 'decline-key-pre');
		const controller = createRecipientDeclineController({
			...base,
			fetch,
			randomUUID
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(randomUUID).not.toHaveBeenCalled();
		expect(controller.getStatus()).toBe('idle');
		expect(controller.getIdempotencyKey()).toBeNull();
	});

	it('posts exact same-origin credentials, payload IDs, and generated idempotency key on confirm', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => successResponse());
		const onStatusChange = vi.fn();
		const onSuccess = vi.fn();
		const controller = createRecipientDeclineController({
			...base,
			fetch,
			randomUUID: () => 'decline-key-123',
			onStatusChange,
			onSuccess
		});

		await controller.confirmDecline();

		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/api/v1/signing/decline');
		expect(init).toMatchObject({
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'content-type': 'application/json',
				'idempotency-key': 'decline-key-123'
			}
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			envelopeId: base.envelopeId,
			recipientId: base.recipientId
		});
		expect(controller.getStatus()).toBe('success');
		expect(onSuccess).toHaveBeenCalledOnce();
		expect(onStatusChange).toHaveBeenCalledWith('pending');
		expect(onStatusChange).toHaveBeenCalledWith('success');
	});

	it('works for approver role as well as signer role', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => successResponse());
		const onSuccess = vi.fn();
		const controller = createRecipientDeclineController({
			...base,
			role: 'approver',
			fetch,
			randomUUID: () => 'approver-key',
			onSuccess
		});

		await controller.confirmDecline();

		expect(fetch).toHaveBeenCalledOnce();
		expect(controller.getStatus()).toBe('success');
		expect(onSuccess).toHaveBeenCalledOnce();
	});

	it('deduplicates concurrent in-flight decline confirmation calls', async () => {
		let resolveFetch: ((response: Response) => void) | null = null;
		const fetchPromise = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const fetch = vi.fn<typeof globalThis.fetch>(() => fetchPromise);

		const controller = createRecipientDeclineController({
			...base,
			fetch,
			randomUUID: () => 'dedup-key'
		});

		const firstCall = controller.confirmDecline();
		expect(controller.isInFlight()).toBe(true);
		expect(controller.getStatus()).toBe('pending');

		// Concurrent second and third calls while in-flight
		const secondCall = controller.confirmDecline();
		const thirdCall = controller.confirmDecline();

		expect(fetch).toHaveBeenCalledTimes(1);

		resolveFetch!(successResponse());
		await Promise.all([firstCall, secondCall, thirdCall]);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(controller.isInFlight()).toBe(false);
		expect(controller.getStatus()).toBe('success');
	});

	it('reuses the exact same idempotency key across transient retries', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockResolvedValueOnce(new Response('{}', { status: 500 }))
			.mockRejectedValueOnce(new Error('Network disconnected'))
			.mockResolvedValueOnce(successResponse());

		const onTransientFailure = vi.fn();
		const onSuccess = vi.fn();

		const controller = createRecipientDeclineController({
			...base,
			fetch,
			randomUUID: () => 'stable-decline-key',
			onTransientFailure,
			onSuccess
		});

		// 1st attempt: 503 transient failure
		await controller.confirmDecline();
		expect(controller.getStatus()).toBe('transient_failure');
		expect(onTransientFailure).toHaveBeenCalledTimes(1);

		// 2nd attempt: 500 transient failure
		await controller.confirmDecline();
		expect(controller.getStatus()).toBe('transient_failure');
		expect(onTransientFailure).toHaveBeenCalledTimes(2);

		// 3rd attempt: network error
		await controller.confirmDecline();
		expect(controller.getStatus()).toBe('transient_failure');
		expect(onTransientFailure).toHaveBeenCalledTimes(3);

		// 4th attempt: success
		await controller.confirmDecline();
		expect(controller.getStatus()).toBe('success');
		expect(onSuccess).toHaveBeenCalledTimes(1);

		expect(fetch).toHaveBeenCalledTimes(4);
		const keys = fetch.mock.calls.map(
			(call) => (call[1]?.headers as Record<string, string>)['idempotency-key']
		);
		expect(keys).toEqual([
			'stable-decline-key',
			'stable-decline-key',
			'stable-decline-key',
			'stable-decline-key'
		]);
	});

	it('does not report success for a mismatched or malformed 200 receipt', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						declined: {
							envelopeId: base.envelopeId,
							recipientId: '00000000-0000-8000-a000-000000000099',
							recipientStatus: 'declined',
							envelopeStatus: 'declined',
							declinedAt: '2026-09-11T00:00:00.000Z'
						}
					}),
					{ status: 200 }
				)
			);
		const onSuccess = vi.fn();
		const controller = createRecipientDeclineController({
			...base,
			fetch,
			randomUUID: () => 'receipt-key',
			onSuccess
		});

		await controller.confirmDecline();
		expect(controller.getStatus()).toBe('transient_failure');
		await controller.confirmDecline();
		expect(controller.getStatus()).toBe('transient_failure');
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('treats 408, 429, and 409 with Retry-After as transient retryable failures', async () => {
		for (const response of [
			new Response('{}', { status: 408 }),
			new Response('{}', { status: 429 }),
			new Response('{}', { status: 409, headers: { 'retry-after': '1' } })
		]) {
			const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
			const onTransientFailure = vi.fn();
			const controller = createRecipientDeclineController({
				...base,
				fetch,
				randomUUID: () => 'retryable-key',
				onTransientFailure
			});

			await controller.confirmDecline();

			expect(controller.getStatus()).toBe('transient_failure');
			expect(onTransientFailure).toHaveBeenCalledOnce();
		}
	});

	it('treats 404 as terminal failure and prevents subsequent calls', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 404 }));
		const onTerminalFailure = vi.fn();
		const controller = createRecipientDeclineController({
			...base,
			fetch,
			randomUUID: () => 'term-404-key',
			onTerminalFailure
		});

		await controller.confirmDecline();

		expect(controller.getStatus()).toBe('terminal_failure');
		expect(onTerminalFailure).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledTimes(1);

		// Subsequent call is a no-op
		await controller.confirmDecline();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('treats permanent 4xx (e.g. 400, 403, 409 without retry-after) as terminal failure', async () => {
		for (const status of [400, 403, 409]) {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(new Response('{}', { status }));
			const onTerminalFailure = vi.fn();
			const controller = createRecipientDeclineController({
				...base,
				fetch,
				randomUUID: () => `term-${status}-key`,
				onTerminalFailure
			});

			await controller.confirmDecline();

			expect(controller.getStatus()).toBe('terminal_failure');
			expect(onTerminalFailure).toHaveBeenCalledOnce();
		}
	});

	it('classifies client failures correctly with isPermanentClientFailure helper', () => {
		// 5xx and < 400 are not permanent client failures
		expect(isPermanentClientFailure(new Response(null, { status: 200 }))).toBe(false);
		expect(isPermanentClientFailure(new Response(null, { status: 500 }))).toBe(false);
		expect(isPermanentClientFailure(new Response(null, { status: 503 }))).toBe(false);

		// 408 and 429 are transient
		expect(isPermanentClientFailure(new Response(null, { status: 408 }))).toBe(false);
		expect(isPermanentClientFailure(new Response(null, { status: 429 }))).toBe(false);

		// 409 with Retry-After is transient
		expect(
			isPermanentClientFailure(new Response(null, { status: 409, headers: { 'retry-after': '1' } }))
		).toBe(false);

		// 409 without Retry-After is permanent
		expect(isPermanentClientFailure(new Response(null, { status: 409 }))).toBe(true);

		// 400, 403, 404, 413, 415 are permanent
		expect(isPermanentClientFailure(new Response(null, { status: 400 }))).toBe(true);
		expect(isPermanentClientFailure(new Response(null, { status: 403 }))).toBe(true);
		expect(isPermanentClientFailure(new Response(null, { status: 404 }))).toBe(true);
		expect(isPermanentClientFailure(new Response(null, { status: 413 }))).toBe(true);
		expect(isPermanentClientFailure(new Response(null, { status: 415 }))).toBe(true);
	});
});
