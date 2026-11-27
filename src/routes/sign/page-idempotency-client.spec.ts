import { base64UrlEncode, OPAQUE_TOKEN_PATTERN } from '$lib/security/opaque-token';
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

function withoutRandomValues(): () => void {
	const original: Crypto = globalThis.crypto;
	Object.defineProperty(globalThis, 'crypto', {
		configurable: true,
		value: {}
	});
	return (): void => {
		Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
	};
}

function headerKey(init: RequestInit | undefined): string {
	return String((init?.headers as Record<string, string>)['idempotency-key']);
}

describe('first-party Idempotency-Key generation', () => {
	it('mints an opaque random key in every signing flow', async () => {
		const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');
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

			expect(getRandomValues).toHaveBeenCalledTimes(4);
			const keys: string[] = fetch.mock.calls.map((call): string => headerKey(call[1]));
			expect(keys).toHaveLength(4);
			expect(new Set(keys).size).toBe(4);
			for (const [index, key] of keys.entries()) {
				expect(key).toMatch(OPAQUE_TOKEN_PATTERN);
				expect(key).toBe(base64UrlEncode(getRandomValues.mock.results[index]?.value as Uint8Array));
			}
		} finally {
			getRandomValues.mockRestore();
		}
	});

	it('fails loudly instead of minting a weak key when crypto.getRandomValues is missing', async () => {
		const restore: () => void = withoutRandomValues();
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
			}).toThrow(/no cryptographic random source/);

			const decline = createRecipientDeclineController({
				envelopeId,
				recipientId,
				role: 'signer',
				pageState: 'active',
				fetch
			});
			await expect(decline.confirmDecline()).rejects.toThrow(/no cryptographic random source/);
			expect(decline.getIdempotencyKey()).toBeNull();

			const approve = createRecipientApproveController({
				envelopeId,
				recipientId,
				role: 'approver',
				pageState: 'active',
				recipientStatus: 'viewed',
				fetch
			});
			await expect(approve.confirmApprove()).rejects.toThrow(/no cryptographic random source/);
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
				/no cryptographic random source/
			);
			expect(sign.getIdempotencyKey()).toBeNull();

			expect(fetch).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it('still uses an injected newIdempotencyKey when crypto.getRandomValues is unavailable', async () => {
		const restore: () => void = withoutRandomValues();
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
