import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PublicCompletionArtifactIntegrityError,
	PublicCompletionArtifactNotFoundError,
	PublicCompletionArtifactStorageError
} from '$lib/application/completion-delivery/public-completion-artifact';

const resolveService = vi.fn();

vi.mock('$lib/application/completion-delivery/completion-delivery-runtime', () => ({
	resolvePublicCompletionArtifactService: (context: unknown) => resolveService(context)
}));

const { load } = await import('./+page.server');

const TOKEN = 'skca1_' + 'a'.repeat(43);

function event(token: string = TOKEN) {
	return {
		params: { token },
		platform: undefined,
		setHeaders: vi.fn()
	} as unknown as Parameters<typeof load>[0];
}

describe('completion receipt page load', () => {
	beforeEach(() => {
		resolveService.mockReset();
	});

	it('sets private, no-store headers and never leaks the token into logs', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const status = vi.fn(async () => ({ pdfAvailable: true }));
		resolveService.mockResolvedValueOnce({ status });
		const setHeaders = vi.fn();

		const result = await load({ ...event(), setHeaders } as never);

		expect(result).toEqual({ state: 'published', pdfAvailable: true });
		expect(setHeaders).toHaveBeenCalledWith(
			expect.objectContaining({ 'cache-control': 'private, no-store' })
		);
		expect(status).toHaveBeenCalledWith(TOKEN);
		for (const call of errorSpy.mock.calls) {
			expect(JSON.stringify(call)).not.toContain(TOKEN);
		}
		errorSpy.mockRestore();
	});

	it('reports pdfAvailable=false when the grant resolves but no PDF has published yet', async () => {
		const status = vi.fn(async () => ({ pdfAvailable: false }));
		resolveService.mockResolvedValueOnce({ status });

		await expect(load(event() as never)).resolves.toEqual({
			state: 'published',
			pdfAvailable: false
		});
	});

	it('returns an opaque invalid state for an unknown, expired, revoked, or wrong-purpose token', async () => {
		const status = vi.fn(async () => {
			throw new PublicCompletionArtifactNotFoundError();
		});
		resolveService.mockResolvedValueOnce({ status });

		await expect(load(event() as never)).resolves.toEqual({ state: 'invalid' });
	});

	it('returns an opaque invalid state for a malformed token without resolving the service', async () => {
		await expect(load(event('not-a-token') as never)).resolves.toEqual({ state: 'invalid' });
		expect(resolveService).not.toHaveBeenCalled();
	});

	it('returns unavailable when the service cannot be resolved', async () => {
		resolveService.mockResolvedValueOnce(null);

		await expect(load(event() as never)).resolves.toEqual({ state: 'unavailable' });
	});

	it('returns unavailable when resolving the service throws', async () => {
		resolveService.mockRejectedValueOnce(new Error('platform binding missing'));

		await expect(load(event() as never)).resolves.toEqual({ state: 'unavailable' });
	});

	it('returns unavailable on an integrity failure without leaking the reason', async () => {
		const status = vi.fn(async () => {
			throw new PublicCompletionArtifactIntegrityError();
		});
		resolveService.mockResolvedValueOnce({ status });

		await expect(load(event() as never)).resolves.toEqual({ state: 'unavailable' });
	});

	it('returns unavailable on a storage failure', async () => {
		const status = vi.fn(async () => {
			throw new PublicCompletionArtifactStorageError();
		});
		resolveService.mockResolvedValueOnce({ status });

		await expect(load(event() as never)).resolves.toEqual({ state: 'unavailable' });
	});
});
