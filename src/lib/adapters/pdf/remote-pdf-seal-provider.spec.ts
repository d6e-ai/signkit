import {
	PdfSealProviderError,
	type PdfSealOperationReference,
	type PdfSealOperationReceipt,
	type PdfSealProviderOperation,
	type PdfSealSucceededOperation,
	type SubmitPdfSealOperation
} from '$lib/ports/pdf-seal-provider';
import { describe, expect, it, vi } from 'vitest';
import {
	RemotePdfSealProvider,
	type RemotePdfSealProviderOptions
} from './remote-pdf-seal-provider';

const SECRET: string = 'provider-secret-that-must-not-leak';
const SOURCE_SHA256: string = 'a'.repeat(64);
const CERTIFICATE_SHA256: string = 'b'.repeat(64);
const TRUST_BUNDLE_SHA256: string = 'c'.repeat(64);
const RESULT_SHA256_PLACEHOLDER: string = 'd'.repeat(64);
const SOURCE_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('%PDF-1.7\nsource');

function reference(overrides: Partial<PdfSealOperationReference> = {}): PdfSealOperationReference {
	return {
		operationId: 'seal-op_01-test',
		sourceSha256: SOURCE_SHA256,
		sourceByteSize: SOURCE_BYTES.byteLength,
		requestedProfile: 'pades-b-b',
		signerCertificateSha256: CERTIFICATE_SHA256,
		sealPolicyId: 'seal-policy-v1',
		validationPolicyId: 'validation-policy-v1',
		tsaPolicyId: null,
		tsaTrustBundleSha256: null,
		...overrides
	};
}

function command(overrides: Partial<SubmitPdfSealOperation> = {}): SubmitPdfSealOperation {
	return {
		...reference(),
		source: byteStream(SOURCE_BYTES),
		...overrides
	};
}

function receipt(
	referenceValue: PdfSealOperationReference = reference(),
	providerReceiptId: string = 'receipt-01'
): PdfSealOperationReceipt {
	return { ...referenceValue, providerReceiptId };
}

function operationEnvelope(
	referenceValue: PdfSealOperationReference,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		...referenceValue,
		status: 'pending',
		providerReceiptId: 'receipt-01',
		...overrides
	};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers: Headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(JSON.stringify(body), { ...init, headers });
}

function byteStream(
	bytes: Uint8Array,
	chunkSize: number = bytes.byteLength
): ReadableStream<Uint8Array> {
	let offset: number = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			const end: number = Math.min(offset + Math.max(chunkSize, 1), bytes.byteLength);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		}
	});
}

function provider(
	fetchImplementation: RemotePdfSealProviderOptions['fetch'],
	overrides: Partial<RemotePdfSealProviderOptions> = {}
): RemotePdfSealProvider {
	return new RemotePdfSealProvider({
		baseUrl: 'https://seal.example.test/api/v1/',
		bearerToken: SECRET,
		maxResultBytes: 1024 * 1024,
		fetch: fetchImplementation,
		...overrides
	});
}

function expectProviderError(
	error: unknown,
	expected: {
		code: PdfSealProviderError['code'];
		retryable: boolean;
		ambiguous: boolean;
		httpStatus?: number | null;
	}
): void {
	expect(error).toBeInstanceOf(PdfSealProviderError);
	const providerFailure: PdfSealProviderError = error as PdfSealProviderError;
	expect({
		code: providerFailure.code,
		retryable: providerFailure.retryable,
		ambiguous: providerFailure.ambiguous,
		httpStatus: providerFailure.httpStatus
	}).toEqual({
		...expected,
		httpStatus: expected.httpStatus ?? null
	});
	expect(providerFailure.message).toBe(expected.code);
	expect(providerFailure.message).not.toContain(SECRET);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

function resultHeaders(
	operation: PdfSealSucceededOperation,
	resultLength: number,
	overrides: Record<string, string> = {}
): Headers {
	return new Headers({
		'content-type': 'application/pdf',
		'content-length': String(resultLength),
		'x-signkit-operation-id': operation.operationId,
		'x-signkit-provider-receipt-id': operation.providerReceiptId,
		'x-signkit-source-sha256': operation.sourceSha256,
		'x-signkit-source-byte-size': String(operation.sourceByteSize),
		'x-signkit-requested-profile': operation.requestedProfile,
		'x-signkit-achieved-profile': operation.achievedProfile,
		'x-signkit-signer-certificate-sha256': operation.signerCertificateSha256,
		'x-signkit-seal-policy-id': operation.sealPolicyId,
		'x-signkit-validation-policy-id': operation.validationPolicyId,
		'x-signkit-result-sha256': operation.resultSha256,
		...overrides
	});
}

describe('RemotePdfSealProvider', () => {
	it('streams submit to a fixed derived endpoint with frozen metadata and no secret in the URL', async () => {
		const requestReference: PdfSealOperationReference = reference({ operationId: 'op:with-colon' });
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const body: Uint8Array = new Uint8Array(
					await new Response(init?.body as BodyInit).arrayBuffer()
				);
				expect(String(input)).toBe('https://seal.example.test/api/v1/pdf-seals/op%3Awith-colon');
				expect(init?.method).toBe('PUT');
				expect(init?.redirect).toBe('error');
				expect(body).toEqual(SOURCE_BYTES);
				const headers: Headers = new Headers(init?.headers);
				expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
				expect(headers.get('idempotency-key')).toBe(requestReference.operationId);
				expect(headers.get('x-signkit-source-sha256')).toBe(SOURCE_SHA256);
				expect(headers.get('x-signkit-source-byte-size')).toBe(String(SOURCE_BYTES.byteLength));
				expect(headers.get('content-length')).toBeNull();
				expect(String(input)).not.toContain(SECRET);
				return jsonResponse(operationEnvelope(requestReference));
			}
		);
		const result: PdfSealProviderOperation = await provider(fetchMock).submit({
			...requestReference,
			source: byteStream(SOURCE_BYTES, 2)
		});
		expect(result).toMatchObject({ status: 'pending', operationId: 'op:with-colon' });
		expect(Object.keys(result).sort()).toEqual([
			'operationId',
			'providerReceiptId',
			'requestedProfile',
			'sealPolicyId',
			'signerCertificateSha256',
			'sourceByteSize',
			'sourceSha256',
			'status',
			'tsaPolicyId',
			'tsaTrustBundleSha256',
			'validationPolicyId'
		]);
		expect('source' in result).toBe(false);
	});

	it('sends and requires the B-T TSA policy tuple', async () => {
		const requestReference: PdfSealOperationReference = reference({
			requestedProfile: 'pades-b-t',
			tsaPolicyId: '1.2.840.113549.1.9.16.1.4',
			tsaTrustBundleSha256: TRUST_BUNDLE_SHA256
		});
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				await new Response(init?.body as BodyInit).arrayBuffer();
				const headers: Headers = new Headers(init?.headers);
				expect(headers.get('x-signkit-tsa-policy-id')).toBe(requestReference.tsaPolicyId);
				expect(headers.get('x-signkit-tsa-trust-bundle-sha256')).toBe(TRUST_BUNDLE_SHA256);
				return jsonResponse(operationEnvelope(requestReference));
			}
		);
		await expect(
			provider(fetchMock).submit({ ...requestReference, source: byteStream(SOURCE_BYTES) })
		).resolves.toMatchObject({ requestedProfile: 'pades-b-t', status: 'pending' });
	});

	it.each([
		'http://seal.example.test',
		'https://user:password@seal.example.test',
		'https://seal.example.test?token=secret',
		'https://seal.example.test/#fragment'
	])('rejects an unsafe base URL without reflecting it: %s', (baseUrl: string) => {
		let caught: unknown;
		try {
			provider(vi.fn(), { baseUrl });
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'invalid_configuration',
			retryable: false,
			ambiguous: false
		});
		expect((caught as Error).message).not.toContain(baseUrl);
	});

	it.each([
		'café',
		'token😀',
		'token:with-colon',
		'token with space',
		'token\nwith-newline',
		'token,with-comma',
		'token"with-quote'
	])('rejects a non-ASCII or unsupported bearer token without reflecting it: %s', (bearerToken) => {
		let caught: unknown;
		try {
			provider(vi.fn(), { bearerToken });
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'invalid_configuration',
			retryable: false,
			ambiguous: false
		});
		expect((caught as Error).message).not.toContain(bearerToken);
	});

	it('accepts the RFC 6750 b64token character set', () => {
		expect(() => provider(vi.fn(), { bearerToken: 'AZaz09-._~+/==' })).not.toThrow();
	});

	it.each([
		{ requestedProfile: 'pades-b-t' as const },
		{ tsaPolicyId: 'unexpected', tsaTrustBundleSha256: TRUST_BUNDLE_SHA256 },
		{ sourceSha256: 'NOT-A-DIGEST' },
		{ operationId: '../escape' }
	])('rejects an invalid frozen request before fetch: %j', async (overrides) => {
		const fetchMock = vi.fn();
		let caught: unknown;
		try {
			await provider(fetchMock).submit(command(overrides));
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'invalid_request',
			retryable: false,
			ambiguous: false
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		['operationId', 'other-op'],
		['sourceSha256', 'f'.repeat(64)],
		['sourceByteSize', SOURCE_BYTES.byteLength + 1],
		['requestedProfile', 'pades-b-t'],
		['signerCertificateSha256', 'e'.repeat(64)],
		['sealPolicyId', 'other-policy'],
		['validationPolicyId', 'other-validation']
	] as const)('rejects a mismatched %s echo', async (field: string, value: unknown) => {
		const requestReference: PdfSealOperationReference = reference();
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(operationEnvelope(requestReference, { [field]: value }))
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt(requestReference));
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'integrity_mismatch',
			retryable: false,
			ambiguous: false
		});
	});

	it('pins a known receipt in the request and rejects a changed receipt in the response', async () => {
		const expectedReceipt: PdfSealOperationReceipt = receipt();
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const headers: Headers = new Headers(init?.headers);
				expect(headers.get('x-signkit-provider-receipt-id')).toBe(
					expectedReceipt.providerReceiptId
				);
				return jsonResponse(
					operationEnvelope(expectedReceipt, { providerReceiptId: 'different-receipt' })
				);
			}
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(expectedReceipt);
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'integrity_mismatch',
			retryable: false,
			ambiguous: false
		});
	});

	it('rejects a B-T to B-B downgrade as an integrity failure', async () => {
		const requestReference: PdfSealOperationReference = reference({
			requestedProfile: 'pades-b-t',
			tsaPolicyId: '1.2.3.4',
			tsaTrustBundleSha256: TRUST_BUNDLE_SHA256
		});
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(
				operationEnvelope(requestReference, {
					status: 'succeeded',
					achievedProfile: 'pades-b-b',
					resultSha256: RESULT_SHA256_PLACEHOLDER,
					resultByteSize: SOURCE_BYTES.byteLength + 100
				})
			)
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt(requestReference));
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'integrity_mismatch',
			retryable: false,
			ambiguous: false
		});
	});

	it('bounds JSON before parsing and cancels an oversized stream', async () => {
		let cancelled: boolean = false;
		const oversized: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			start(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.enqueue(new Uint8Array(65 * 1024));
			},
			cancel(): void {
				cancelled = true;
			}
		});
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(oversized, { headers: { 'content-type': 'application/json' } })
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'response_too_large',
			retryable: false,
			ambiguous: false
		});
		expect(cancelled).toBe(true);
	});

	it.each([
		[408, 'request_timeout', true],
		[425, 'rate_limited', true],
		[429, 'rate_limited', true],
		[503, 'provider_unavailable', true],
		[401, 'provider_authentication_failed', false],
		[404, 'operation_not_found', false],
		[409, 'operation_conflict', false],
		[422, 'provider_rejected', false]
	] as const)(
		'classifies HTTP %i without exposing its bounded body',
		async (status, code, retryable) => {
			const fetchMock = vi.fn(
				async (): Promise<Response> => new Response(SECRET.repeat(2000), { status })
			);
			let caught: unknown;
			try {
				await provider(fetchMock).getStatus(receipt());
			} catch (error: unknown) {
				caught = error;
			}
			expectProviderError(caught, { code, retryable, ambiguous: false, httpStatus: status });
		}
	);

	it('marks an interrupted submit ambiguous and recovers through the same operation URL', async () => {
		const requestReference: PdfSealOperationReference = reference();
		const urls: string[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				urls.push(String(input));
				if (urls.length === 1) throw new Error(`${SECRET}: connection reset`);
				expect(new Headers(init?.headers).get('x-signkit-provider-receipt-id')).toBeNull();
				return jsonResponse(operationEnvelope(requestReference, { status: 'processing' }));
			}
		);
		const adapter: RemotePdfSealProvider = provider(fetchMock);
		let caught: unknown;
		try {
			await adapter.submit({ ...requestReference, source: byteStream(SOURCE_BYTES) });
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'network_error',
			retryable: true,
			ambiguous: true
		});
		await expect(adapter.recoverAmbiguousSubmit(requestReference)).resolves.toMatchObject({
			status: 'processing'
		});
		expect(urls).toEqual([
			'https://seal.example.test/api/v1/pdf-seals/seal-op_01-test',
			'https://seal.example.test/api/v1/pdf-seals/seal-op_01-test'
		]);
	});

	it('does not mark an explicit permanent submit rejection ambiguous', async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => new Response(SECRET, { status: 401 }));
		let caught: unknown;
		try {
			await provider(fetchMock).submit(command());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'provider_authentication_failed',
			retryable: false,
			ambiguous: false,
			httpStatus: 401
		});
	});

	it('keeps malformed submit responses ambiguous for same-ID recovery', async () => {
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response('{}', {
					headers: { 'content-type': 'application/json', 'content-length': 'not-a-number' }
				})
		);
		let caught: unknown;
		try {
			await provider(fetchMock).submit(command());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'invalid_response',
			retryable: false,
			ambiguous: true
		});
	});

	it('sanitizes a response stream failure instead of exposing its error', async () => {
		const brokenBody: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.error(new Error(`${SECRET}: broken response body`));
			}
		});
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(brokenBody, { headers: { 'content-type': 'application/json' } })
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'network_error',
			retryable: true,
			ambiguous: false
		});
	});

	it('maps a timeout without reflecting the thrown provider detail', async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			const error: Error = new Error(`${SECRET}: upstream took too long`);
			error.name = 'TimeoutError';
			throw error;
		});
		let caught: unknown;
		try {
			await provider(fetchMock).submit(command());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'request_timeout',
			retryable: true,
			ambiguous: true
		});
	});

	it('preserves a deterministic source-size failure wrapped by Node fetch', async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			const wrapped: Error & { cause?: unknown } = new TypeError('fetch failed');
			wrapped.cause = new PdfSealProviderError('source_size_mismatch', false, true);
			throw wrapped;
		});
		let caught: unknown;
		try {
			await provider(fetchMock).submit(command());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'source_size_mismatch',
			retryable: false,
			ambiguous: true
		});
	});

	it.each([408, 425, 429] as const)(
		'treats an explicit retryable submit HTTP %i response as non-ambiguous',
		async (status: number) => {
			const fetchMock = vi.fn(async (): Promise<Response> => new Response(null, { status }));
			let caught: unknown;
			try {
				await provider(fetchMock).submit(command());
			} catch (error: unknown) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(PdfSealProviderError);
			expect((caught as PdfSealProviderError).retryable).toBe(true);
			expect((caught as PdfSealProviderError).ambiguous).toBe(false);
		}
	);

	it('marks a post-dispatch source-size mismatch ambiguous and recovers the same operation', async () => {
		const requestReference: PdfSealOperationReference = reference();
		const urls: string[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				urls.push(String(input));
				if (init?.method === 'PUT') {
					await new Response(init.body as BodyInit).arrayBuffer();
				}
				return jsonResponse(operationEnvelope(requestReference, { status: 'processing' }));
			}
		);
		const adapter: RemotePdfSealProvider = provider(fetchMock);
		let caught: unknown;
		try {
			await adapter.submit(command({ source: byteStream(SOURCE_BYTES.slice(0, -1)) }));
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'source_size_mismatch',
			retryable: false,
			ambiguous: true
		});
		await expect(adapter.recoverAmbiguousSubmit(requestReference)).resolves.toMatchObject({
			status: 'processing',
			providerReceiptId: 'receipt-01'
		});
		expect(urls).toEqual([
			'https://seal.example.test/api/v1/pdf-seals/seal-op_01-test',
			'https://seal.example.test/api/v1/pdf-seals/seal-op_01-test'
		]);
	});

	it('returns only an exact, digest-verified result from the fixed result endpoint', async () => {
		const resultBytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
			'%PDF-1.7\nsource\n%% incremental PAdES seal'
		);
		const resultSha256: string = await sha256Hex(resultBytes);
		const operation: PdfSealSucceededOperation = {
			...reference(),
			status: 'succeeded',
			providerReceiptId: 'receipt-01',
			achievedProfile: 'pades-b-b',
			resultSha256,
			resultByteSize: resultBytes.byteLength
		};
		const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			expect(String(input)).toBe(
				'https://seal.example.test/api/v1/pdf-seals/seal-op_01-test/result'
			);
			return new Response(byteStream(resultBytes, 3), {
				headers: resultHeaders(operation, resultBytes.byteLength)
			});
		});
		await expect(provider(fetchMock).readResult(operation)).resolves.toEqual({
			bytes: resultBytes,
			sha256: resultSha256,
			byteSize: resultBytes.byteLength,
			achievedProfile: 'pades-b-b',
			providerReceiptId: 'receipt-01'
		});
	});

	it.each([
		['x-signkit-source-sha256', 'f'.repeat(64), 'integrity_mismatch'],
		['x-signkit-achieved-profile', 'pades-b-t', 'integrity_mismatch'],
		['content-type', 'text/html', 'invalid_response'],
		['content-encoding', 'gzip', 'invalid_response']
	] as const)('rejects an invalid result %s', async (header, value, code) => {
		const resultBytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
			'%PDF-1.7\nsource\n%% incremental seal'
		);
		const resultSha256: string = await sha256Hex(resultBytes);
		const operation: PdfSealSucceededOperation = {
			...reference(),
			status: 'succeeded',
			providerReceiptId: 'receipt-01',
			achievedProfile: 'pades-b-b',
			resultSha256,
			resultByteSize: resultBytes.byteLength
		};
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(resultBytes, {
					headers: resultHeaders(operation, resultBytes.byteLength, { [header]: value })
				})
		);
		let caught: unknown;
		try {
			await provider(fetchMock).readResult(operation);
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code,
			retryable: false,
			ambiguous: false
		});
	});

	it('rejects result bytes that differ from the attested digest', async () => {
		const resultBytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
			'%PDF-1.7\nsource\n%% incremental seal'
		);
		const operation: PdfSealSucceededOperation = {
			...reference(),
			status: 'succeeded',
			providerReceiptId: 'receipt-01',
			achievedProfile: 'pades-b-b',
			resultSha256: RESULT_SHA256_PLACEHOLDER,
			resultByteSize: resultBytes.byteLength
		};
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(resultBytes, {
					headers: resultHeaders(operation, resultBytes.byteLength)
				})
		);
		let caught: unknown;
		try {
			await provider(fetchMock).readResult(operation);
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'integrity_mismatch',
			retryable: false,
			ambiguous: false
		});
	});

	it('rejects result metadata above the configured bound before fetching bytes', async () => {
		const requestReference: PdfSealOperationReference = reference();
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(
				operationEnvelope(requestReference, {
					status: 'succeeded',
					achievedProfile: 'pades-b-b',
					resultSha256: RESULT_SHA256_PLACEHOLDER,
					resultByteSize: 1024 * 1024 + 1
				})
			)
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt(requestReference));
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'response_too_large',
			retryable: false,
			ambiguous: false
		});
	});

	it('rejects redirect responses even when an injected fetch returns one', async () => {
		const redirected: Response = jsonResponse(operationEnvelope(reference()));
		Object.defineProperty(redirected, 'redirected', { value: true });
		const fetchMock = vi.fn(async (): Promise<Response> => redirected);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'provider_redirected',
			retryable: false,
			ambiguous: false,
			httpStatus: 200
		});
	});

	it('classifies an explicit non-followed 3xx response as a rejected redirect', async () => {
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(null, { status: 307, headers: { location: 'https://other.example.test' } })
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'provider_redirected',
			retryable: false,
			ambiguous: false,
			httpStatus: 307
		});
	});

	it('classifies a timed-out response body as a timeout without leaking detail', async () => {
		const timedOutBody: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
				const error: Error = new Error(`${SECRET}: body timeout`);
				error.name = 'TimeoutError';
				controller.error(error);
			}
		});
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(timedOutBody, { headers: { 'content-type': 'application/json' } })
		);
		let caught: unknown;
		try {
			await provider(fetchMock).getStatus(receipt());
		} catch (error: unknown) {
			caught = error;
		}
		expectProviderError(caught, {
			code: 'request_timeout',
			retryable: true,
			ambiguous: false
		});
	});
});
