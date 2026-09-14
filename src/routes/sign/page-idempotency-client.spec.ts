import { describe, expect, it, vi } from 'vitest';
import {
	createRecipientApproveController,
	createRecipientDeclineController,
	createRecipientSignController,
	initRecipientViewed
} from './[envelopeId]/+page.svelte';

const envelopeId = '01910000-0000-7000-8000-000000000001';
const recipientId = '01910000-0000-7000-8000-000000000002';
const fieldId = '01910000-0000-7000-8000-000000000003';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function withoutRandomUUID(): () => void {
	const original: Crypto = globalThis.crypto;
	Object.defineProperty(globalThis, 'crypto', {
		configurable: true,
		value: {
			getRandomValues: original.getRandomValues.bind(original)
		}
	});
	return (): void => {
		Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
	};
}

function headerKey(init: RequestInit | undefined): string {
	return String((init?.headers as Record<string, string>)['idempotency-key']);
}

describe('first-party Idempotency-Key generation', () => {
	it('mints a UUIDv4 from crypto.randomUUID in every signing flow', async () => {
		const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID');
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (): Promise<Response> => new Response('{}', { status: 503 })
		);
		try {
			initRecipientViewed({
				envelopeId,
				recipientId,
				initialStatus: 'pending',
				pageState: 'active',
				fetch
			});
			await vi.waitFor((): void => expect(fetch).toHaveBeenCalledOnce());

			const decline = createRecipientDeclineController({
				envelopeId,
				recipientId,
				role: 'signer',
				pageState: 'active',
				fetch
			});
			await decline.confirmDecline();

			const approve = createRecipientApproveController({
				envelopeId,
				recipientId,
				role: 'approver',
				pageState: 'active',
				recipientStatus: 'viewed',
				fetch
			});
			await approve.confirmApprove();

			const sign = createRecipientSignController({
				envelopeId,
				recipientId,
				expectedFieldGeneration: 1,
				role: 'signer',
				pageState: 'active',
				recipientStatus: 'viewed',
				fetch
			});
			await sign.confirmSign([{ fieldId, value: 'Jane Doe' }]);

			expect(randomUUID).toHaveBeenCalledTimes(4);
			const keys: string[] = fetch.mock.calls.map((call): string => headerKey(call[1]));
			expect(keys).toHaveLength(4);
			expect(new Set(keys).size).toBe(4);
			for (const [index, key] of keys.entries()) {
				expect(key).toMatch(uuidV4);
				expect(key).toBe(randomUUID.mock.results[index]?.value);
			}
		} finally {
			randomUUID.mockRestore();
		}
	});

	it('fails loudly instead of minting a weak key when crypto.randomUUID is missing', async () => {
		const restore: () => void = withoutRandomUUID();
		const fetch = vi.fn();
		try {
			expect((): void => {
				initRecipientViewed({
					envelopeId,
					recipientId,
					initialStatus: 'pending',
					pageState: 'active',
					fetch
				});
			}).toThrow(/crypto\.randomUUID\(\) is required to mint an Idempotency-Key/);

			const decline = createRecipientDeclineController({
				envelopeId,
				recipientId,
				role: 'signer',
				pageState: 'active',
				fetch
			});
			await expect(decline.confirmDecline()).rejects.toThrow(/crypto\.randomUUID/);
			expect(decline.getIdempotencyKey()).toBeNull();

			const approve = createRecipientApproveController({
				envelopeId,
				recipientId,
				role: 'approver',
				pageState: 'active',
				recipientStatus: 'viewed',
				fetch
			});
			await expect(approve.confirmApprove()).rejects.toThrow(/crypto\.randomUUID/);
			expect(approve.getIdempotencyKey()).toBeNull();

			const sign = createRecipientSignController({
				envelopeId,
				recipientId,
				expectedFieldGeneration: 1,
				role: 'signer',
				pageState: 'active',
				recipientStatus: 'viewed',
				fetch
			});
			await expect(sign.confirmSign([{ fieldId, value: 'Jane Doe' }])).rejects.toThrow(
				/crypto\.randomUUID/
			);
			expect(sign.getIdempotencyKey()).toBeNull();

			expect(fetch).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it('still uses an injected newIdempotencyKey when crypto.randomUUID is unavailable', async () => {
		const restore: () => void = withoutRandomUUID();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (): Promise<Response> => new Response('{}', { status: 503 })
		);
		try {
			initRecipientViewed({
				envelopeId,
				recipientId,
				initialStatus: 'pending',
				pageState: 'active',
				fetch,
				newIdempotencyKey: (): string => 'injected-view-key'
			});
			await vi.waitFor((): void => expect(fetch).toHaveBeenCalledOnce());

			const decline = createRecipientDeclineController({
				envelopeId,
				recipientId,
				role: 'signer',
				pageState: 'active',
				fetch,
				newIdempotencyKey: (): string => 'injected-decline-key'
			});
			await decline.confirmDecline();

			const approve = createRecipientApproveController({
				envelopeId,
				recipientId,
				role: 'approver',
				pageState: 'active',
				recipientStatus: 'viewed',
				fetch,
				newIdempotencyKey: (): string => 'injected-approve-key'
			});
			await approve.confirmApprove();

			const sign = createRecipientSignController({
				envelopeId,
				recipientId,
				expectedFieldGeneration: 1,
				role: 'signer',
				pageState: 'active',
				recipientStatus: 'viewed',
				fetch,
				newIdempotencyKey: (): string => 'injected-sign-key'
			});
			await sign.confirmSign([{ fieldId, value: 'Jane Doe' }]);

			expect(fetch.mock.calls.map((call): string => headerKey(call[1]))).toEqual([
				'injected-view-key',
				'injected-decline-key',
				'injected-approve-key',
				'injected-sign-key'
			]);
		} finally {
			restore();
		}
	});
});
