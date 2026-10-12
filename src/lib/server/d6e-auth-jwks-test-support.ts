import { vi } from 'vitest';

/**
 * Stubs global `fetch` to route by exact URL, returning each matching
 * route's response and counting calls per URL. Registering several JWKS
 * origins in one router is what makes per-origin cache isolation and the
 * bounded resolver cache's eviction testable without juggling several
 * independent `vi.stubGlobal` calls across a test.
 */
export function mockFetchRouter(responses: Map<string, () => Response>): Map<string, number> {
	const calls: Map<string, number> = new Map();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url: string = typeof input === 'string' ? input : input.toString();
			const respond = responses.get(url);
			if (respond === undefined) throw new Error(`unexpected fetch in test: ${url}`);
			calls.set(url, (calls.get(url) ?? 0) + 1);
			return respond();
		})
	);
	return calls;
}
