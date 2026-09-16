import { describe, expect, it, vi } from 'vitest';
import {
	runScheduledMaintenance,
	SCHEDULED_MAINTENANCE_JOBS,
	type ScheduledWorkerFetch
} from './scheduled-maintenance';

const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

describe('Cloudflare scheduled maintenance', () => {
	it('invokes every required drain and sweep through waitUntil without chaining', async () => {
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

		runScheduledMaintenance(fetchHandler, { DELIVERY_WORKER_SECRET: SECRET }, context);
		expect(pending).toHaveLength(SCHEDULED_MAINTENANCE_JOBS.length);
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

		runScheduledMaintenance(fetchHandler, { DELIVERY_WORKER_SECRET: SECRET }, context);
		const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(pending);

		expect(pending).toHaveLength(SCHEDULED_MAINTENANCE_JOBS.length);
		expect(fetchHandler).toHaveBeenCalledTimes(SCHEDULED_MAINTENANCE_JOBS.length);
		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_failed',
				job: 'delivery drain',
				message: 'Error'
			})
		);
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
});
