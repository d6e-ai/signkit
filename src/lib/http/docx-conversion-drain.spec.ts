import { describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from '@sveltejs/kit';
import type { DocxConversionService } from '$lib/application/documents/docx-conversion-service';
import { createDocxConversionDrainHandler } from './docx-conversion-drain';

const PATHNAME: string = '/api/v1/system/docx-conversions/drain';
const SECRET: string = 'docx-worker-secret-0123456789abcdef';

function event(authorization?: string): Parameters<RequestHandler>[0] {
	return {
		request: new Request(`https://signkit.test${PATHNAME}`, {
			method: 'POST',
			headers: authorization === undefined ? {} : { authorization }
		}),
		url: new URL(`https://signkit.test${PATHNAME}`),
		platform: undefined
	} as Parameters<RequestHandler>[0];
}

describe('DOCX conversion drain', () => {
	it('rejects a missing worker credential before resolving dependencies', async () => {
		const resolver = vi.fn();
		const response: Response = await createDocxConversionDrainHandler(
			resolver,
			(): string => SECRET
		)(event());
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('runs a bounded batch for an authenticated worker', async () => {
		const processPendingBatch = vi.fn().mockResolvedValue({
			claimed: 0,
			succeeded: 0,
			failed: 0,
			stale: 0,
			items: []
		});
		const service = { processPendingBatch } as unknown as DocxConversionService;
		const response: Response = await createDocxConversionDrainHandler(
			(): DocxConversionService => service,
			(): string => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(response.status).toBe(200);
		expect(processPendingBatch).toHaveBeenCalledWith({ limit: 10 });
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('fails closed when the service is unavailable', async () => {
		const response: Response = await createDocxConversionDrainHandler(
			(): null => null,
			(): string => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(response.status).toBe(503);
	});
});
