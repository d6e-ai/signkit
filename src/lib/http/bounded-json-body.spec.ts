import type { ZodIssue } from 'zod';
import { describe, expect, it } from 'vitest';
import { acceptsJson, readJsonBody, validationErrors } from './bounded-json-body';

function streamRequest(body: ReadableStream<Uint8Array>, headers: HeadersInit = {}): Request {
	return new Request('https://signkit.example/resource', {
		method: 'POST',
		headers,
		body,
		duplex: 'half'
	} as RequestInit & { duplex: 'half' });
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe('readJsonBody', () => {
	it('parses a small valid JSON body', async () => {
		const request: Request = new Request('https://signkit.example/resource', {
			method: 'POST',
			body: '{"a":1}'
		});
		await expect(readJsonBody(request, 1024)).resolves.toEqual({ ok: true, value: { a: 1 } });
	});

	it('rejects a body declared larger than the limit via content-length', async () => {
		const request: Request = new Request('https://signkit.example/resource', {
			method: 'POST',
			headers: { 'content-length': '9999' },
			body: '{}'
		});
		await expect(readJsonBody(request, 10)).resolves.toEqual({ ok: false, reason: 'too_large' });
	});

	it('cancels the stream reader once the byte limit is exceeded mid-stream', async () => {
		let cancelReason: unknown;
		const body = new ReadableStream<Uint8Array>({
			pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.enqueue(bytes('x'.repeat(64)));
			},
			cancel(reason: unknown): void {
				cancelReason = reason;
			}
		});
		const request: Request = streamRequest(body);
		await expect(readJsonBody(request, 16)).resolves.toEqual({ ok: false, reason: 'too_large' });
		expect(cancelReason).toBeDefined();
	});

	it('maps a failing request body stream to invalid rather than throwing', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.error(new Error('client disconnected'));
			}
		});
		const request: Request = streamRequest(body);
		await expect(readJsonBody(request, 1024)).resolves.toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects malformed UTF-8 as invalid instead of decoding with replacement characters', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.enqueue(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
				controller.close();
			}
		});
		const request: Request = streamRequest(body);
		await expect(readJsonBody(request, 1024)).resolves.toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects syntactically invalid JSON', async () => {
		const request: Request = new Request('https://signkit.example/resource', {
			method: 'POST',
			body: '{invalid'
		});
		await expect(readJsonBody(request, 1024)).resolves.toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects a null body', async () => {
		const request: Request = new Request('https://signkit.example/resource', { method: 'GET' });
		await expect(readJsonBody(request, 1024)).resolves.toEqual({ ok: false, reason: 'invalid' });
	});
});

describe('acceptsJson', () => {
	it('accepts application/json with parameters', () => {
		const request: Request = new Request('https://signkit.example/resource', {
			headers: { 'content-type': 'application/json; charset=utf-8' }
		});
		expect(acceptsJson(request)).toBe(true);
	});

	it('rejects a missing or non-JSON content type', () => {
		const missing: Request = new Request('https://signkit.example/resource');
		const other: Request = new Request('https://signkit.example/resource', {
			headers: { 'content-type': 'text/plain' }
		});
		expect(acceptsJson(missing)).toBe(false);
		expect(acceptsJson(other)).toBe(false);
	});
});

describe('validationErrors', () => {
	const issues: readonly ZodIssue[] = [
		{ code: 'custom', path: [], message: 'root issue' } as ZodIssue,
		{ code: 'custom', path: ['name'], message: 'nested issue' } as ZodIssue
	];

	it('emits bare field paths by default', () => {
		expect(validationErrors(issues)).toEqual([
			{ path: '$', message: 'root issue' },
			{ path: 'name', message: 'nested issue' }
		]);
	});

	it('emits JSON-Pointer-style paths when prefixRoot is set', () => {
		expect(validationErrors(issues, true)).toEqual([
			{ path: '$', message: 'root issue' },
			{ path: '$.name', message: 'nested issue' }
		]);
	});
});
