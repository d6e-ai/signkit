import { describe, expect, it, vi } from 'vitest';
import {
	MAINTENANCE_BATCH_OBSERVED_HEADER,
	logMaintenanceBatchCompleted,
	logMaintenanceBatchFailure,
	logMaintenanceBatchSummaryUnavailable,
	logMaintenanceOperationError,
	maintenanceBatchHasFailureSignal,
	observeMaintenanceBatchResult,
	readMaintenanceBatchSummary,
	summarizeMaintenanceBatchResult
} from './maintenance-telemetry';

describe('summarizeMaintenanceBatchResult', () => {
	it('keeps only known non-negative safe-integer count fields', () => {
		expect(
			summarizeMaintenanceBatchResult({
				claimed: 3,
				integrityFailed: 1,
				outcomes: [{ id: 'leak-me', email: 'user@example.com' }],
				note: 'should be dropped',
				negative: -1,
				fractional: 1.5
			})
		).toEqual({ claimed: 3, integrityFailed: 1 });
	});

	it('rejects an unsafe-integer value for an otherwise known field', () => {
		expect(summarizeMaintenanceBatchResult({ claimed: 2 ** 53 })).toEqual({});
	});

	it('returns an empty summary for non-object or array input', () => {
		expect(summarizeMaintenanceBatchResult(null)).toEqual({});
		expect(summarizeMaintenanceBatchResult([1, 2, 3])).toEqual({});
		expect(summarizeMaintenanceBatchResult('not an object')).toEqual({});
	});
});

describe('maintenanceBatchHasFailureSignal', () => {
	it('is false for an empty or all-zero summary', () => {
		expect(maintenanceBatchHasFailureSignal({})).toBe(false);
		expect(maintenanceBatchHasFailureSignal({ claimed: 5, delivered: 5, failed: 0 })).toBe(false);
	});

	it('is true when any failure-like field is positive', () => {
		expect(maintenanceBatchHasFailureSignal({ retryableFailed: 1 })).toBe(true);
		expect(maintenanceBatchHasFailureSignal({ permanentlyFailed: 1 })).toBe(true);
		expect(maintenanceBatchHasFailureSignal({ integrityFailed: 1 })).toBe(true);
		expect(maintenanceBatchHasFailureSignal({ unrecoverable: 1 })).toBe(true);
		expect(maintenanceBatchHasFailureSignal({ failed: 1 })).toBe(true);
	});
});

describe('readMaintenanceBatchSummary', () => {
	it('decodes a well-formed batch body', async () => {
		const response: Response = Response.json({ claimed: 2, integrityFailed: 1 });
		const result = await readMaintenanceBatchSummary(response, 64 * 1024);
		expect(result).toEqual({ ok: true, summary: { claimed: 2, integrityFailed: 1 } });
	});

	it('rejects a body larger than the declared content-length bound without reading the stream', async () => {
		const response: Response = new Response('{"claimed":1}', {
			headers: { 'content-length': '999999' }
		});
		const result = await readMaintenanceBatchSummary(response, 1024);
		expect(result).toEqual({ ok: false, reason: 'too_large' });
	});

	it('cancels the stream once the byte limit is exceeded even without a content-length header', async () => {
		const chunk: Uint8Array = new TextEncoder().encode('x'.repeat(2000));
		let cancelled: boolean = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			}
		});
		const response: Response = new Response(stream);
		const result = await readMaintenanceBatchSummary(response, 1024);
		expect(result).toEqual({ ok: false, reason: 'too_large' });
		expect(cancelled).toBe(true);
	});

	it('treats malformed JSON as invalid rather than throwing', async () => {
		const response: Response = new Response('not json', { status: 200 });
		const result = await readMaintenanceBatchSummary(response, 1024);
		expect(result).toEqual({ ok: false, reason: 'invalid' });
	});

	it('treats a missing body as unavailable', async () => {
		const response: Response = new Response(null, { status: 200 });
		const result = await readMaintenanceBatchSummary(response, 1024);
		expect(result).toEqual({ ok: false, reason: 'unavailable' });
	});

	it.each([
		null,
		[],
		{},
		{ outcomes: [] },
		{ claimed: 1, failed: -1 },
		{ claimed: 1, failed: '1' },
		{ claimed: 1, failed: 0.5 },
		{ claimed: 1, failed: 2 ** 53 }
	])(
		'rejects missing counters or invalid known counters rather than reporting a healthy batch: %j',
		async (body): Promise<void> => {
			expect(await readMaintenanceBatchSummary(Response.json(body), 1024)).toEqual({
				ok: false,
				reason: 'invalid'
			});
		}
	);
});

describe('logMaintenanceOperationError', () => {
	it('logs only the event and error name, never the raw error message', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		logMaintenanceOperationError(
			'drain_failed',
			new Error('contains a secret token ski1_abc123 and user@example.com')
		);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'drain_failed',
			message: 'Error'
		});
		errorSpy.mockRestore();
	});
});

describe('logMaintenanceBatchFailure', () => {
	it('logs the job, duration, and only the bounded count fields', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		logMaintenanceBatchFailure('delivery drain', { claimed: 2, integrityFailed: 1 }, 42);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'scheduled_maintenance_batch_failed',
			job: 'delivery drain',
			durationMs: 42,
			claimed: 2,
			integrityFailed: 1
		});
		errorSpy.mockRestore();
	});
});

describe('logMaintenanceBatchCompleted', () => {
	it('logs at a non-error, low-noise severity', () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		logMaintenanceBatchCompleted('webhook drain', { claimed: 0 }, 5);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'scheduled_maintenance_batch_completed',
			job: 'webhook drain',
			durationMs: 5,
			claimed: 0
		});
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});

describe('logMaintenanceBatchSummaryUnavailable', () => {
	it('warns exactly once with the job, duration, and sanitized reason, never a no-op', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
		logMaintenanceBatchSummaryUnavailable('orphan sweep', 10, 'too_large');
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'scheduled_maintenance_batch_summary_unavailable',
			job: 'orphan sweep',
			durationMs: 10,
			reason: 'too_large'
		});
		warnSpy.mockRestore();
	});
});

describe('observeMaintenanceBatchResult', () => {
	it('reports an unobservable handler result without logging a successful batch or private details', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const headers = observeMaintenanceBatchResult(
			'delivery drain',
			{ claimed: 0, failed: 'private-provider-error' },
			7
		);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(logSpy).not.toHaveBeenCalled();
		expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'scheduled_maintenance_batch_summary_unavailable',
			job: 'delivery drain',
			durationMs: 7,
			reason: 'invalid'
		});
		expect(headers).toEqual({ [MAINTENANCE_BATCH_OBSERVED_HEADER]: '1' });
		warnSpy.mockRestore();
		logSpy.mockRestore();
	});
	it('logs a failure and returns the observed-batch header when a failure-like count is present', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const headers = observeMaintenanceBatchResult(
			'delivery drain',
			{ claimed: 2, integrityFailed: 1, outcomes: [{ id: 'leak-me' }] },
			12
		);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'scheduled_maintenance_batch_failed',
			job: 'delivery drain',
			durationMs: 12,
			claimed: 2,
			integrityFailed: 1
		});
		expect(headers).toEqual({ [MAINTENANCE_BATCH_OBSERVED_HEADER]: '1' });
		errorSpy.mockRestore();
	});

	it('logs a low-noise completion and returns the observed-batch header for a healthy batch', () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const headers = observeMaintenanceBatchResult('orphan sweep', { scanned: 0, deleted: 0 }, 3);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledOnce();
		expect(headers).toEqual({ [MAINTENANCE_BATCH_OBSERVED_HEADER]: '1' });
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
