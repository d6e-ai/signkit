import { describe, expect, it, vi } from 'vitest';
import {
	ORPHAN_SWEEP_CRON,
	ORPHAN_SWEEP_JOBS,
	PRIMARY_MAINTENANCE_CRON,
	PRIMARY_MAINTENANCE_JOBS,
	runScheduledMaintenance,
	SCHEDULED_MAINTENANCE_JOBS,
	type ScheduledWorkerFetch
} from './scheduled-maintenance';

const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

describe('Cloudflare scheduled maintenance', () => {
	it('isolates orphan collection in its own cron invocation', async () => {
		const fetchHandler: ScheduledWorkerFetch = vi.fn(async (request) => {
			expect(request.method).toBe('POST');
			expect(request.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
			return new Response(null, { status: 200 });
		});
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			PRIMARY_MAINTENANCE_CRON
		);
		expect(pending).toHaveLength(PRIMARY_MAINTENANCE_JOBS.length);
		await Promise.all(pending);
		pending.length = 0;
		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			ORPHAN_SWEEP_CRON
		);
		expect(pending).toHaveLength(ORPHAN_SWEEP_JOBS.length);
		await Promise.all(pending);

		const paths: string[] = vi
			.mocked(fetchHandler)
			.mock.calls.map(([request]) => new URL(request.url).pathname)
			.sort();
		expect(paths).toEqual([...SCHEDULED_MAINTENANCE_JOBS.map((job) => job.path)].sort());
		expect(paths).toContain('/api/v1/system/webhooks/drain');
		expect(paths).toContain('/api/v1/system/docx-conversions/drain');
		expect(paths).toContain('/api/v1/system/objects/orphan-sweep');
		expect(paths).toContain('/api/v1/system/envelopes/expiry-drain');
		expect(paths).toContain('/api/v1/system/deliveries/reseal-sweep');
		expect(paths).toContain('/api/v1/system/completion-deliveries/reseal-sweep');
		expect(paths).toContain('/api/v1/system/pdf-seals/drain');
	});

	it('isolates a failing job so sibling drains still run', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(async (request) => {
			const path: string = new URL(request.url).pathname;
			if (path === '/api/v1/system/deliveries/drain') {
				return new Response(null, { status: 503 });
			}
			return new Response(null, { status: 200 });
		});
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			PRIMARY_MAINTENANCE_CRON
		);
		const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(pending);

		expect(pending).toHaveLength(PRIMARY_MAINTENANCE_JOBS.length);
		expect(fetchHandler).toHaveBeenCalledTimes(PRIMARY_MAINTENANCE_JOBS.length);
		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_failed',
				job: 'delivery drain',
				code: 'maintenance_http_failed',
				status: 503
			})
		);
		errorSpy.mockRestore();
	});

	it('does not duplicate a failure already logged by a maintenance handler', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(async (request) => {
			if (new URL(request.url).pathname === '/api/v1/system/objects/orphan-sweep') {
				return new Response(null, {
					status: 503,
					headers: { 'x-signkit-maintenance-failure-code': 'reference_lookup_failed' }
				});
			}
			return new Response(null, { status: 200 });
		});
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			ORPHAN_SWEEP_CRON
		);
		await Promise.all(pending);

		expect(fetchHandler).toHaveBeenCalledTimes(ORPHAN_SWEEP_JOBS.length);
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('does not fetch when the worker secret is missing and still isolates each job', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(
			async () => new Response(null, { status: 200 })
		);
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(fetchHandler, {}, context);
		const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(pending);

		expect(fetchHandler).not.toHaveBeenCalled();
		expect(results).toHaveLength(SCHEDULED_MAINTENANCE_JOBS.length);
		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
		expect(errorSpy).toHaveBeenCalledTimes(SCHEDULED_MAINTENANCE_JOBS.length);
		const loggedJobs: string[] = errorSpy.mock.calls
			.map((call): unknown => call[0])
			.map((entry: unknown): { job?: unknown } => JSON.parse(String(entry)))
			.map((entry: { job?: unknown }): string => String(entry.job))
			.sort();
		expect(loggedJobs).toEqual([...SCHEDULED_MAINTENANCE_JOBS.map((job) => job.name)].sort());
		errorSpy.mockRestore();
	});

	it('passes the execution context through rather than destructuring waitUntil', async () => {
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};
		const fetchHandler: ScheduledWorkerFetch = vi.fn(async (_request, _env, ctx) => {
			expect(ctx).toBe(context);
			return new Response(null, { status: 200 });
		});

		runScheduledMaintenance(fetchHandler, { DELIVERY_WORKER_SECRET: SECRET }, context);
		await Promise.all(pending);
		expect(fetchHandler).toHaveBeenCalledTimes(SCHEDULED_MAINTENANCE_JOBS.length);
	});

	it('fails closed for an unrecognized cron expression', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(
			async () => new Response(null, { status: 200 })
		);
		const context = { waitUntil: vi.fn() };

		runScheduledMaintenance(fetchHandler, { DELIVERY_WORKER_SECRET: SECRET }, context, '0 0 * * *');

		expect(fetchHandler).not.toHaveBeenCalled();
		expect(context.waitUntil).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'scheduled_maintenance_unknown_cron',
			code: 'maintenance_schedule_unrecognized'
		});
		errorSpy.mockRestore();
	});

	it('does not re-decode or re-log a response the handler already observed', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ claimed: 3, integrityFailed: 1 }), {
					status: 200,
					headers: { 'x-signkit-maintenance-batch-observed': '1' }
				})
		);
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			PRIMARY_MAINTENANCE_CRON
		);
		await Promise.all(pending);

		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('falls back to its own bounded decode and logs an HTTP 200 batch result with failures exactly once, including duration', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(async (request) => {
			const path: string = new URL(request.url).pathname;
			if (path === '/api/v1/system/deliveries/drain') {
				return Response.json({
					claimed: 3,
					delivered: 1,
					retryableFailed: 1,
					permanentlyFailed: 0,
					integrityFailed: 1,
					stale: 0,
					outcomes: [{ deliveryId: 'delivery-1', outcome: 'delivered' }]
				});
			}
			return new Response(null, { status: 200 });
		});
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			PRIMARY_MAINTENANCE_CRON
		);
		await Promise.all(pending);

		expect(errorSpy).toHaveBeenCalledOnce();
		const logged: Record<string, unknown> = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
		expect(logged).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_failed',
				job: 'delivery drain',
				claimed: 3,
				delivered: 1,
				retryableFailed: 1,
				integrityFailed: 1
			})
		);
		expect(typeof logged.durationMs).toBe('number');
		expect(logged).not.toHaveProperty('outcomes');
		errorSpy.mockRestore();
	});

	it('does not log anything for an empty, healthy batch', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(async () =>
			Response.json({
				claimed: 0,
				delivered: 0,
				retryableFailed: 0,
				permanentlyFailed: 0,
				integrityFailed: 0,
				stale: 0,
				outcomes: []
			})
		);
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			PRIMARY_MAINTENANCE_CRON
		);
		await Promise.all(pending);

		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('warns exactly once (not a silent no-op) for a malformed, unmarked batch body', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const fetchHandler: ScheduledWorkerFetch = vi.fn(
			async () => new Response('not json', { status: 200 })
		);
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			PRIMARY_MAINTENANCE_CRON
		);
		const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(pending);

		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledTimes(PRIMARY_MAINTENANCE_JOBS.length);
		expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_summary_unavailable',
				reason: 'invalid'
			})
		);
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it('is bounded against an oversized batch body without reading it unbounded, and warns exactly once', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const oversized: string = JSON.stringify({
			claimed: 1,
			integrityFailed: 1,
			padding: 'x'.repeat(200_000)
		});
		const fetchHandler: ScheduledWorkerFetch = vi.fn(
			async () => new Response(oversized, { status: 200 })
		);
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil(promise: Promise<unknown>): void {
				pending.push(promise);
			}
		};

		runScheduledMaintenance(
			fetchHandler,
			{ DELIVERY_WORKER_SECRET: SECRET },
			context,
			PRIMARY_MAINTENANCE_CRON
		);
		const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(pending);

		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledTimes(PRIMARY_MAINTENANCE_JOBS.length);
		expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_summary_unavailable',
				reason: 'too_large'
			})
		);
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
