import { describe, expect, it, vi } from 'vitest';
import { initRecipientViewed } from './[envelopeId]/+page.svelte';

function browser(initialVisibility: DocumentVisibilityState = 'visible') {
	const documentListeners = new Map<string, (event?: unknown) => void>();
	const windowListeners = new Map<string, (event?: unknown) => void>();
	const document = {
		visibilityState: initialVisibility,
		addEventListener: vi.fn((type: string, listener: (event?: unknown) => void): void => {
			documentListeners.set(type, listener);
		}),
		removeEventListener: vi.fn((type: string): void => {
			documentListeners.delete(type);
		})
	};
	const window = {
		addEventListener: vi.fn((type: string, listener: (event?: unknown) => void): void => {
			windowListeners.set(type, listener);
		}),
		removeEventListener: vi.fn((type: string): void => {
			windowListeners.delete(type);
		})
	};
	return { document, window, documentListeners, windowListeners };
}

const base = {
	envelopeId: '01910000-0000-7000-8000-000000000001',
	recipientId: '01910000-0000-7000-8000-000000000002',
	initialStatus: 'pending',
	pageState: 'active'
};

describe('recipient viewed browser trigger', () => {
	it('does nothing for inactive pages and already-viewed recipients', () => {
		for (const options of [
			{ ...base, pageState: 'invalid' },
			{ ...base, initialStatus: 'viewed' }
		]) {
			const fetch = vi.fn();
			const newIdempotencyKey = vi.fn(() => 'view-key');
			initRecipientViewed({ ...options, fetch, newIdempotencyKey });
			expect(fetch).not.toHaveBeenCalled();
			expect(newIdempotencyKey).not.toHaveBeenCalled();
		}
	});

	it('waits for foreground visibility before posting the exact context', async () => {
		const surface = browser('hidden');
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (): Promise<Response> => new Response('{}', { status: 200 })
		);
		const recorded = vi.fn();
		initRecipientViewed({
			...base,
			...surface,
			fetch,
			newIdempotencyKey: () => 'view-key-1',
			onRecorded: recorded
		});
		expect(fetch).not.toHaveBeenCalled();

		surface.document.visibilityState = 'visible';
		surface.documentListeners.get('visibilitychange')?.();
		await vi.waitFor((): void => expect(fetch).toHaveBeenCalledOnce());
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/api/v1/signing/viewed');
		expect(init).toMatchObject({
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'content-type': 'application/json',
				'idempotency-key': 'view-key-1'
			}
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			envelopeId: base.envelopeId,
			recipientId: base.recipientId
		});
		await vi.waitFor((): void => expect(recorded).toHaveBeenCalledOnce());
	});

	it('reuses one idempotency key and retries only on a later browser event', async () => {
		const surface = browser();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockResolvedValueOnce(new Response('{}', { status: 200 }));
		const retryPending = vi.fn();
		initRecipientViewed({
			...base,
			...surface,
			fetch,
			newIdempotencyKey: () => 'stable-view-key',
			onRetryPendingChange: retryPending
		});
		await vi.waitFor((): void => expect(fetch).toHaveBeenCalledOnce());
		await vi.waitFor((): void => expect(retryPending).toHaveBeenCalledWith(true));
		expect(fetch).toHaveBeenCalledTimes(1);

		surface.windowListeners.get('online')?.();
		await vi.waitFor((): void => expect(fetch).toHaveBeenCalledTimes(2));
		expect(
			fetch.mock.calls.map((call): string =>
				String((call[1]?.headers as Record<string, string>)['idempotency-key'])
			)
		).toEqual(['stable-view-key', 'stable-view-key']);
	});

	it('treats 404 as terminal and removes retry listeners', async () => {
		const surface = browser();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (): Promise<Response> => new Response('{}', { status: 404 })
		);
		initRecipientViewed({ ...base, ...surface, fetch, newIdempotencyKey: () => 'view-key' });
		await vi.waitFor((): void => expect(fetch).toHaveBeenCalledOnce());
		expect(surface.documentListeners.has('visibilitychange')).toBe(false);
		expect(surface.windowListeners.has('online')).toBe(false);
	});

	it('stops retrying permanent client failures and reports a terminal failure', async () => {
		const surface = browser();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (): Promise<Response> => new Response('{}', { status: 409 })
		);
		const terminalFailure = vi.fn();
		const retryPending = vi.fn();
		initRecipientViewed({
			...base,
			...surface,
			fetch,
			newIdempotencyKey: () => 'conflicted-key',
			onTerminalFailure: terminalFailure,
			onRetryPendingChange: retryPending
		});
		await vi.waitFor((): void => expect(fetch).toHaveBeenCalledOnce());
		expect(terminalFailure).toHaveBeenCalledOnce();
		expect(retryPending).toHaveBeenCalledWith(false);
		expect(surface.documentListeners.has('visibilitychange')).toBe(false);
		expect(surface.windowListeners.has('online')).toBe(false);
	});

	it('keeps an audit-head conflict retryable when the server supplies Retry-After', async () => {
		const surface = browser();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (): Promise<Response> =>
				new Response('{}', { status: 409, headers: { 'retry-after': '1' } })
		);
		const retryPending = vi.fn();
		initRecipientViewed({
			...base,
			...surface,
			fetch,
			newIdempotencyKey: () => 'audit-race-key',
			onRetryPendingChange: retryPending
		});
		await vi.waitFor((): void => expect(fetch).toHaveBeenCalledOnce());
		expect(retryPending).toHaveBeenCalledWith(true);
		expect(surface.documentListeners.has('visibilitychange')).toBe(true);
		expect(surface.windowListeners.has('online')).toBe(true);
	});
});
