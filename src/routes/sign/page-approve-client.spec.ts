import { describe, expect, it, vi } from 'vitest';
import { createRecipientApproveController, validateApprovedReceipt } from './+page.svelte';

const base = {
	envelopeId: '01910000-0000-7000-8000-000000000001',
	recipientId: '01910000-0000-7000-8000-000000000002',
	role: 'approver',
	pageState: 'active',
	recipientStatus: 'viewed'
};

function successResponse(
	envelopeStatus: 'in_progress' | 'completed' = 'in_progress',
	replayed = false
): Response {
	return new Response(
		JSON.stringify({
			approved: {
				envelopeId: base.envelopeId,
				recipientId: base.recipientId,
				recipientStatus: 'completed',
				envelopeStatus,
				approvedAt: '2026-09-11T00:00:00.000Z'
			}
		}),
		{
			status: 200,
			headers: replayed ? { 'idempotency-replayed': 'true' } : undefined
		}
	);
}

describe('recipient approve client controller', () => {
	it('allows only an active, viewed approver', async () => {
		for (const options of [
			{ ...base, role: 'signer' },
			{ ...base, role: 'viewer' },
			{ ...base, role: 'prefill' },
			{ ...base, recipientStatus: 'pending' },
			{ ...base, pageState: 'invalid' }
		]) {
			const fetch = vi.fn();
			const controller = createRecipientApproveController({ ...options, fetch });
			await controller.confirmApprove();
			expect(fetch).not.toHaveBeenCalled();
			expect(controller.getIdempotencyKey()).toBeNull();
		}
	});

	it('can become actionable after the durable viewed receipt arrives', async () => {
		let recipientStatus = 'pending';
		const fetch = vi.fn<typeof globalThis.fetch>(async () => successResponse());
		const controller = createRecipientApproveController({
			...base,
			recipientStatus: () => recipientStatus,
			fetch,
			newIdempotencyKey: () => 'approve-after-view-key'
		});

		await controller.confirmApprove();
		expect(fetch).not.toHaveBeenCalled();
		recipientStatus = 'viewed';
		await controller.confirmApprove();
		expect(fetch).toHaveBeenCalledOnce();
		expect(controller.getStatus()).toBe('success');
	});

	it('posts only equality constraints with same-origin credentials', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => successResponse());
		const controller = createRecipientApproveController({
			...base,
			fetch,
			newIdempotencyKey: () => 'approve-key'
		});

		await controller.confirmApprove();

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/api/v1/signing/approve');
		expect(init).toMatchObject({
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'content-type': 'application/json',
				'idempotency-key': 'approve-key'
			}
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			envelopeId: base.envelopeId,
			recipientId: base.recipientId
		});
		expect(controller.getReceipt()).toMatchObject({
			recipientStatus: 'completed',
			envelopeStatus: 'in_progress'
		});
	});

	it('deduplicates in-flight calls and reuses one key across transient retries', async () => {
		let release: ((response: Response) => void) | undefined;
		const first = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(() => first)
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockResolvedValueOnce(successResponse());
		const controller = createRecipientApproveController({
			...base,
			fetch,
			newIdempotencyKey: () => 'stable-approve-key'
		});

		const pending = controller.confirmApprove();
		void controller.confirmApprove();
		expect(fetch).toHaveBeenCalledOnce();
		release?.(new Response('{}', { status: 503 }));
		await pending;
		await controller.confirmApprove();
		await controller.confirmApprove();

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(
			fetch.mock.calls.map(
				(call) => (call[1]?.headers as Record<string, string>)['idempotency-key']
			)
		).toEqual(['stable-approve-key', 'stable-approve-key', 'stable-approve-key']);
		expect(controller.getStatus()).toBe('success');
	});

	it('records the replay header only after an exact receipt', async () => {
		const onSuccess = vi.fn();
		const controller = createRecipientApproveController({
			...base,
			fetch: async () => successResponse('completed', true),
			onSuccess
		});

		await controller.confirmApprove();

		expect(controller.isReplayed()).toBe(true);
		expect(controller.getReceipt()).toMatchObject({ replayed: true, envelopeStatus: 'completed' });
		expect(onSuccess).toHaveBeenCalledWith(
			expect.objectContaining({ replayed: true, receipt: expect.any(Object) })
		);
	});

	it('rejects malformed, mismatched, or over-broad success receipts', async () => {
		for (const approved of [
			{},
			{
				envelopeId: base.envelopeId,
				recipientId: '01910000-0000-7000-8000-000000000099',
				recipientStatus: 'completed',
				envelopeStatus: 'in_progress',
				approvedAt: '2026-09-11T00:00:00.000Z'
			},
			{
				envelopeId: base.envelopeId,
				recipientId: base.recipientId,
				recipientStatus: 'approved',
				envelopeStatus: 'sent',
				approvedAt: '2026-09-11T00:00:00.000Z'
			}
		]) {
			const response = new Response(JSON.stringify({ approved }), { status: 200 });
			await expect(
				validateApprovedReceipt(response, base.envelopeId, base.recipientId)
			).resolves.toBeNull();
		}
	});

	it('makes missing access and definite client failures terminal while server failures stay retryable', async () => {
		for (const status of [403, 404]) {
			const terminal = createRecipientApproveController({
				...base,
				fetch: async () => new Response('{}', { status })
			});
			await terminal.confirmApprove();
			expect(terminal.getStatus()).toBe('terminal_failure');
		}

		for (const status of [408, 429, 503]) {
			const transient = createRecipientApproveController({
				...base,
				fetch: async () => new Response('{}', { status })
			});
			await transient.confirmApprove();
			expect(transient.getStatus()).toBe('transient_failure');
		}
	});

	it('stops retrying when a malformed success is followed by a cleared-session 404', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
			.mockResolvedValueOnce(new Response('{}', { status: 404 }));
		const controller = createRecipientApproveController({ ...base, fetch });

		await controller.confirmApprove();
		expect(controller.getStatus()).toBe('transient_failure');
		await controller.confirmApprove();

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(controller.getStatus()).toBe('terminal_failure');
		await controller.confirmApprove();
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
