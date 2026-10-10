import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { PdfSealRuntime } from '$lib/application/pdf-seals/pdf-seal-runtime';
import type { PdfSealDrainService } from '$lib/application/pdf-seals/pdf-seal-drain-service';
import { MAINTENANCE_BATCH_OBSERVED_HEADER } from '$lib/observability/maintenance-telemetry';
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
		expect(response.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
	});

	it('marks a healthy batch observed, and logs a failure summary when integrityFailed > 0', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const healthyApp = runtime();
		const healthyResponse: Response = await createPdfSealDrainHandler(
			() => healthyApp as PdfSealRuntime,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(healthyResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledOnce();

		const failingApp = runtime();
		vi.mocked(failingApp.drainService.drain).mockResolvedValueOnce({
			processing: { claimed: 1, outcomes: [] },
			publicationCandidates: 0,
			published: 0,
			replayed: 0,
			stale: 0,
			integrityFailed: 1,
			retryableFailed: 0,
			publicationOutcomes: []
		} as never);
		const failingResponse: Response = await createPdfSealDrainHandler(
			() => failingApp as PdfSealRuntime,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(failingResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_failed',
				job: 'PDF seal drain',
				integrityFailed: 1
			})
		);
		logSpy.mockRestore();
		errorSpy.mockRestore();
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
