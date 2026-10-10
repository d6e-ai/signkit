import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { CompletionArtifactPublicationService } from '$lib/application/completion-artifacts/completion-artifact-service';
import { MAINTENANCE_BATCH_OBSERVED_HEADER } from '$lib/observability/maintenance-telemetry';
import {
	createCompletionArtifactDrainHandler,
	type CompletionArtifactServiceResolver
} from './completion-artifact-drain';
import { createDrainRequestEvent } from './drain-test-support';

const PATHNAME: string = '/api/v1/system/completion-artifacts/drain';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

function service() {
	return {
		publishPendingCompletionArtifacts: vi.fn(async () => ({
			claimed: 1,
			published: 1,
			retryableFailed: 0,
			permanentlyFailed: 0,
			integrityFailed: 0,
			stale: 0,
			outcomes: [{ envelopeId: 'envelope-1', outcome: 'published' as const }]
		}))
	};
}

describe('completion artifact drain HTTP handler', () => {
	it.each([undefined, 'Basic abc', 'Bearer too-short', `Bearer  ${SECRET}`])(
		'rejects malformed authorization before resolving the service: %s',
		async (authorization) => {
			const resolver: CompletionArtifactServiceResolver = vi.fn(() => null);
			const response: Response = await createCompletionArtifactDrainHandler(
				resolver,
				() => SECRET
			)(event(authorization));

			expect(response.status).toBe(401);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(resolver).not.toHaveBeenCalled();
			expect(await response.text()).not.toContain(SECRET);
		}
	);

	it('rejects a well-formed wrong secret before resolving the service', async () => {
		const resolver: CompletionArtifactServiceResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createCompletionArtifactDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(wrong);
	});

	it('passes platform only after authentication and returns a bounded secret-free batch', async () => {
		const app = service();
		const resolver: CompletionArtifactServiceResolver = vi.fn(
			() => app as unknown as CompletionArtifactPublicationService
		);
		const platform = { env: { DELIVERY_WORKER_SECRET: SECRET } } as unknown as App.Platform;
		const response: Response = await createCompletionArtifactDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.publishPendingCompletionArtifacts).toHaveBeenCalledWith(10);
		expect(await response.json()).toMatchObject({ claimed: 1, published: 1 });
	});

	it('fails closed when the worker secret or completion artifact runtime is unavailable', async () => {
		const missingSecret: Response = await createCompletionArtifactDrainHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const missingRuntime: Response = await createCompletionArtifactDrainHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(missingSecret.status).toBe(503);
		expect(missingRuntime.status).toBe(503);
	});

	it('does not expose thrown storage details', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const app = service();
		app.publishPendingCompletionArtifacts.mockRejectedValueOnce(
			new Error(`Object storage failed ${SECRET}`)
		);
		const response: Response = await createCompletionArtifactDrainHandler(
			() => app as unknown as CompletionArtifactPublicationService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		const body: string = await response.text();

		expect(response.status).toBe(503);
		expect(body).not.toContain(SECRET);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'completion_artifact_drain_failed', message: 'Error' })
		);
		error.mockRestore();
	});

	it('marks a healthy batch observed, and logs a failure summary when integrityFailed > 0', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const healthyResponse: Response = await createCompletionArtifactDrainHandler(
			() => service() as unknown as CompletionArtifactPublicationService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(healthyResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledOnce();

		const failing = {
			publishPendingCompletionArtifacts: vi.fn(async () => ({
				claimed: 1,
				published: 0,
				retryableFailed: 0,
				permanentlyFailed: 0,
				integrityFailed: 1,
				stale: 0,
				outcomes: [
					{ envelopeId: 'envelope-1', outcome: 'integrity_failed' as const, errorCode: 'x' }
				]
			}))
		};
		const failingResponse: Response = await createCompletionArtifactDrainHandler(
			() => failing as unknown as CompletionArtifactPublicationService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(failingResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_failed',
				job: 'completion artifact drain',
				integrityFailed: 1
			})
		);
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
