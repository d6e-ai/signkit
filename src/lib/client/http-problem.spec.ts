import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	isReplayedResponse,
	parseProblemResponse,
	requestJson,
	type Problem
} from './http-problem';
import { createEnvelopesClient, EnvelopesApiError } from './envelopes';
import { createContactsClient, ContactsApiError } from './contacts';
import { createInstanceManagementClient, InstanceManagementApiError } from './instance-management';

interface ProblemFixture {
	name: string;
	httpStatus: number;
	path: string;
	body: Record<string, unknown>;
	expected: Problem;
}

// Rust consumes this same wire fixture, retaining its own extension policy.
const fixtures: ProblemFixture[] = JSON.parse(
	readFileSync('cli/tests/fixtures/http-problems.json', 'utf8')
) as ProblemFixture[];

describe('shared browser problem transport', () => {
	it.each(fixtures)('$name agrees with the Rust wire contract', async (fixture) => {
		const response = new Response(JSON.stringify(fixture.body), {
			status: fixture.httpStatus,
			headers: { 'content-type': 'application/problem+json' }
		});
		await expect(parseProblemResponse(response, fixture.path)).resolves.toEqual(fixture.expected);
	});

	it.each([
		['text/html', '<html>upstream private diagnostic</html>'],
		['application/problem+json', '{broken'],
		['application/json', 'null'],
		['application/json', 'false']
	])('uses a bounded fallback for %s / %s', async (contentType, body) => {
		const response = new Response(body, {
			status: 502,
			statusText: 'Bad Gateway',
			headers: { 'content-type': contentType }
		});
		await expect(parseProblemResponse(response, '/api/v1/envelopes')).resolves.toEqual({
			status: 502,
			type: 'urn:signkit:problem:http-502',
			title: 'Bad Gateway',
			detail: 'Request failed with status 502',
			instance: '/api/v1/envelopes'
		});
	});

	it('keeps the existing permissive browser field defaults', async () => {
		const response = new Response(
			JSON.stringify({
				status: 0,
				errors: [null, 42, {}, { path: '$.name', message: 'Required' }]
			}),
			{ status: 422, headers: { 'content-type': 'application/json' } }
		);
		await expect(parseProblemResponse(response, '/api/v1/contacts')).resolves.toMatchObject({
			status: 0,
			errors: [
				{ path: '$', message: 'Validation error' },
				{ path: '$.name', message: 'Required' }
			]
		});
	});

	it('preserves request bytes, signal, credentials override, and the original response', async () => {
		const response = new Response('{"receipt":"ok"}');
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
		const signal = new AbortController().signal;
		const body = '{"title":"Synthetic","expectedGeneration":1}';
		const headers = { 'idempotency-key': 'opaque-reused-key', 'content-type': 'application/json' };
		const buildError = vi.fn(() => new Error('unexpected'));
		const result = await requestJson<{ receipt: string }>(
			fetch,
			'/api/v1/envelopes',
			{ method: 'POST', body, headers, signal, credentials: 'omit' },
			buildError
		);
		expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/v1/envelopes', {
			method: 'POST',
			body,
			headers,
			signal,
			credentials: 'omit'
		});
		expect(result.data).toEqual({ receipt: 'ok' });
		expect(result.response).toBe(response);
		expect(buildError).not.toHaveBeenCalled();
	});

	it('does not reinterpret a network failure or retry the request', async () => {
		const cause = new TypeError('connection lost');
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw cause;
		});
		const buildError = vi.fn(() => new Error('unexpected'));
		await expect(requestJson(fetch, '/api/v1/envelopes', {}, buildError)).rejects.toBe(cause);
		expect(fetch).toHaveBeenCalledOnce();
		expect(buildError).not.toHaveBeenCalled();
	});

	it('does not trust a replay header on malformed success JSON', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response('{broken', {
					headers: { 'idempotency-replayed': 'true' }
				})
		);
		const cause = new Error('invalid JSON');
		const buildError = vi.fn(() => cause);
		await expect(requestJson(fetch, '/api/v1/envelopes', {}, buildError)).rejects.toBe(cause);
		expect(buildError).toHaveBeenCalledExactlyOnceWith(
			{
				status: 200,
				type: 'urn:signkit:problem:invalid-response-json',
				title: 'Invalid response JSON',
				detail: 'The response body could not be parsed as JSON.',
				instance: '/api/v1/envelopes'
			},
			false
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each(['false', 'TRUE', '1', ''])('requires the exact replay header value, not %s', (value) => {
		expect(
			isReplayedResponse(new Response(null, { headers: { 'idempotency-replayed': value } }))
		).toBe(false);
	});

	it.each([
		{
			name: 'envelopes',
			error: EnvelopesApiError,
			request: (fetch: typeof globalThis.fetch) => createEnvelopesClient({ fetch }).list()
		},
		{
			name: 'contacts',
			error: ContactsApiError,
			request: (fetch: typeof globalThis.fetch) => createContactsClient({ fetch }).list()
		},
		{
			name: 'instance',
			error: InstanceManagementApiError,
			request: (fetch: typeof globalThis.fetch) =>
				createInstanceManagementClient({ fetch }).getCurrentMember()
		}
	])('retains the $name error subclass and replay state', async ({ error, request }) => {
		const fixture = fixtures[0];
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify(fixture.body), {
					status: 422,
					headers: { 'content-type': 'application/problem+json', 'idempotency-replayed': 'true' }
				})
		);
		const result: unknown = await request(fetch).catch((cause: unknown) => cause);
		expect(result).toBeInstanceOf(error);
		expect(result).toMatchObject({ ...fixture.expected, replayed: true });
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0][1]?.credentials).toBe('same-origin');
	});
});
