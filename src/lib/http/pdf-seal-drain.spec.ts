import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { PdfSealRuntime } from '$lib/application/pdf-seals/pdf-seal-runtime';
import type { PdfSealDrainService } from '$lib/application/pdf-seals/pdf-seal-drain-service';
import { createDrainRequestEvent } from './drain-test-support';
import { createPdfSealDrainHandler, type PdfSealRuntimeResolver } from './pdf-seal-drain';

const PATHNAME: string = '/api/v1/system/pdf-seals/drain';
const SECRET: string = 'maintenance-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

function runtime() {
	return {
		drainService: {
			drain: vi.fn(async () => ({
				processing: { claimed: 1, outcomes: [{ jobId: 'job-1', outcome: 'submitted' }] },
				publicationCandidates: 0,
				published: 0,
				replayed: 0,
				stale: 0,
				integrityFailed: 0,
				retryableFailed: 0,
				publicationOutcomes: []
			}))
		} as unknown as PdfSealDrainService,
		requestPolicy: {
			requestedProfile: 'pades-b-b' as const,
			signerCertificateSha256: 'a'.repeat(64),
			sealPolicyId: 'seal-policy-v1',
			validationPolicyId: 'validation-policy-v1',
			tsaPolicyId: null,
			tsaTrustBundleSha256: null
		}
	};
}

describe('PDF seal drain HTTP handler', () => {
	it.each([undefined, 'Basic abc', 'Bearer too-short', `Bearer  ${SECRET}`])(
		'rejects malformed authorization before runtime resolution: %s',
		async (authorization) => {
			const resolver: PdfSealRuntimeResolver = vi.fn(() => null);
			const response: Response = await createPdfSealDrainHandler(
				resolver,
				() => SECRET
			)(event(authorization));
			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
			expect(await response.text()).not.toContain(SECRET);
		}
	);

	it('authenticates before resolving and returns a bounded safe result', async () => {
		const app = runtime();
		const resolver: PdfSealRuntimeResolver = vi.fn(() => app as PdfSealRuntime);
		const platform = { env: { DELIVERY_WORKER_SECRET: SECRET } } as App.Platform;
		const response: Response = await createPdfSealDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.drainService.drain).toHaveBeenCalledOnce();
		expect(await response.json()).toMatchObject({
			processing: { claimed: 1 },
			publicationCandidates: 0
		});
	});

	it('treats an intentionally disabled runtime as a successful no-op', async () => {
		const response: Response = await createPdfSealDrainHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(response.status).toBe(204);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.text()).toBe('');
	});

	it('fails closed when the maintenance secret or configured runtime is unavailable', async () => {
		const missingSecret = await createPdfSealDrainHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const invalidRuntime = await createPdfSealDrainHandler(
			() => {
				throw new Error(`secret=${SECRET}`);
			},
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(missingSecret.status).toBe(503);
		expect(invalidRuntime.status).toBe(503);
		expect(await invalidRuntime.text()).not.toContain(SECRET);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'pdf_seal_runtime_resolution_failed', message: 'Error' })
		);
		error.mockRestore();
	});

	it('does not expose failures thrown by the drain', async () => {
		const app = runtime();
		vi.mocked(app.drainService.drain).mockRejectedValueOnce(new Error(`token=${SECRET}`));
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const response: Response = await createPdfSealDrainHandler(
			() => app as PdfSealRuntime,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(SECRET);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'pdf_seal_drain_failed', message: 'Error' })
		);
		error.mockRestore();
	});
});
