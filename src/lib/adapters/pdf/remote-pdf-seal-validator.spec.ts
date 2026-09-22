import {
	PdfSealValidatorError,
	type PdfSealTimestampChecks,
	type PdfSealValidationChecks,
	type PdfSealValidationReference,
	type PdfSealValidationResult,
	type ValidatePdfSealCommand
} from '$lib/ports/pdf-seal-validator';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
	RemotePdfSealValidator,
	type RemotePdfSealValidatorOptions
} from './remote-pdf-seal-validator';

const SECRET: string = 'validator-secret-that-must-not-leak';
const SOURCE_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('%PDF-1.7\nsource');
const SEALED_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
	'%PDF-1.7\nsource\nincremental-seal'
);
const SOURCE_SHA256: string = 'a'.repeat(64);
const SEALED_SHA256: string = 'b'.repeat(64);
const CERTIFICATE_SHA256: string = 'c'.repeat(64);
const TRUST_BUNDLE_SHA256: string = 'd'.repeat(64);

interface RedirectTestServer {
	origin: string;
	counts: { redirect: number; followed: number };
	close(): Promise<void>;
}

async function startRedirectTestServer(): Promise<RedirectTestServer> {
	const counts: { redirect: number; followed: number } = { redirect: 0, followed: 0 };
	const server: Server = createServer(
		(request: IncomingMessage, response: ServerResponse): void => {
			request.resume();
			request.once('end', (): void => {
				if (request.url === '/redirect') {
					counts.redirect += 1;
					response.writeHead(307, { location: '/followed', 'content-type': 'text/plain' });
					response.end('redirect body');
					return;
				}
				counts.followed += 1;
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end('{}');
			});
		}
	);
	await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
		const onError = (error: Error): void => reject(error);
		server.once('error', onError);
		server.listen(0, '127.0.0.1', (): void => {
			server.off('error', onError);
			resolve();
		});
	});
	const address: AddressInfo | string | null = server.address();
	if (address === null || typeof address === 'string') throw new Error('test server did not bind');
	return {
		origin: `http://127.0.0.1:${address.port}`,
		counts,
		close: async (): Promise<void> => {
			await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
				server.close((error?: Error): void => (error === undefined ? resolve() : reject(error)));
				server.closeAllConnections();
			});
		}
	};
}

function reference(
	overrides: Partial<PdfSealValidationReference> = {}
): PdfSealValidationReference {
	return {
		validationId: 'validation-01',
		operationId: 'seal-operation-01',
		sourceSha256: SOURCE_SHA256,
		sourceByteSize: SOURCE_BYTES.byteLength,
		sealedSha256: SEALED_SHA256,
		sealedByteSize: SEALED_BYTES.byteLength,
		requestedProfile: 'pades-b-b',
		signerCertificateSha256: CERTIFICATE_SHA256,
		sealPolicyId: 'seal-policy-v1',
		validationPolicyId: 'validation-policy-v1',
		tsaPolicyId: null,
		tsaTrustBundleSha256: null,
		...overrides
	};
}

function command(overrides: Partial<ValidatePdfSealCommand> = {}): ValidatePdfSealCommand {
	return {
		...reference(),
		source: byteStream(SOURCE_BYTES, 3),
		sealed: byteStream(SEALED_BYTES, 4),
		...overrides
	};
}

function validChecks(timestamp: PdfSealTimestampChecks | null = null): PdfSealValidationChecks {
	return {
		sourcePrefixExact: true,
		incrementalUpdateValid: true,
		byteRangeComplete: true,
		cmsSignatureValid: true,
		cmsSubFilter: 'ETSI.CAdES.detached',
		signerCertificateProtected: true,
		signerCertificateDigestMatches: true,
		certificatePathValid: true,
		sealPolicyValid: true,
		invisibleApprovalSignature: true,
		docMdpAbsent: true,
		noPostSealChanges: true,
		timestamp
	};
}

function timestampChecks(): PdfSealTimestampChecks {
	return {
		responseStatusGranted: true,
		messageImprintValid: true,
		nonceValidWhenPresent: true,
		policyValid: true,
		tokenSignatureValid: true,
		certificatePathValid: true,
		ekuCriticalTimeStampingOnly: true,
		essCertificateBindingValid: true,
		genTimeValid: true
	};
}

function validEnvelope(
	referenceValue: PdfSealValidationReference,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		...referenceValue,
		status: 'valid',
		achievedProfile: referenceValue.requestedProfile,
		validatorReceiptId: 'validator-receipt-01',
		checks: validChecks(referenceValue.requestedProfile === 'pades-b-t' ? timestampChecks() : null),
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

function validator(
	fetchImplementation: NonNullable<RemotePdfSealValidatorOptions['fetch']>,
	overrides: Partial<RemotePdfSealValidatorOptions> = {},
	autoConsumeBody: boolean = true
): RemotePdfSealValidator {
	return new RemotePdfSealValidator({
		baseUrl: 'https://validator.example.test/api/v1/',
		bearerToken: SECRET,
		maxSealedBytes: 1024 * 1024,
		fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const response: Response = await fetchImplementation(input, init);
			const requestBody: BodyInit | null | undefined = init?.body;
			if (autoConsumeBody && requestBody instanceof ReadableStream && !requestBody.locked) {
				await new Response(requestBody).arrayBuffer();
			}
			return response;
		},
		...overrides
	});
}

function expectValidatorError(
	error: unknown,
	expected: {
		code: PdfSealValidatorError['code'];
		retryable: boolean;
		httpStatus?: number | null;
	}
): void {
	expect(error).toBeInstanceOf(PdfSealValidatorError);
	const failure: PdfSealValidatorError = error as PdfSealValidatorError;
	expect({
		code: failure.code,
		retryable: failure.retryable,
		httpStatus: failure.httpStatus
	}).toEqual({
		...expected,
		httpStatus: expected.httpStatus ?? null
	});
	expect(failure.message).toBe(expected.code);
	expect(failure.message).not.toContain(SECRET);
}

async function capturedError(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
		return null;
	} catch (error: unknown) {
		return error;
	}
}

describe('RemotePdfSealValidator', () => {
	it('streams exact source and sealed frames to one fixed endpoint with frozen metadata', async () => {
		const requestReference: PdfSealValidationReference = reference({
			validationId: 'validation:colon'
		});
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const bytes: Uint8Array = new Uint8Array(
					await new Response(init?.body as BodyInit).arrayBuffer()
				);
				expect(String(input)).toBe(
					'https://validator.example.test/api/v1/pdf-seal-validations/validation%3Acolon'
				);
				expect(init?.method).toBe('PUT');
				expect(init?.redirect).toBe('manual');
				expect(bytes).toEqual(new Uint8Array([...SOURCE_BYTES, ...SEALED_BYTES]));
				const headers: Headers = new Headers(init?.headers);
				expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
				expect(headers.get('content-type')).toBe('application/vnd.signkit.pdf-seal-validation-v1');
				expect(headers.get('idempotency-key')).toBe(requestReference.validationId);
				expect(headers.get('x-signkit-source-sha256')).toBe(SOURCE_SHA256);
				expect(headers.get('x-signkit-source-byte-size')).toBe(String(SOURCE_BYTES.byteLength));
				expect(headers.get('x-signkit-sealed-sha256')).toBe(SEALED_SHA256);
				expect(headers.get('x-signkit-sealed-byte-size')).toBe(String(SEALED_BYTES.byteLength));
				expect(headers.get('accept-encoding')).toBe('identity');
				expect(headers.has('x-signkit-tsa-policy-id')).toBe(false);
				expect(headers.has('x-signkit-tsa-trust-bundle-sha256')).toBe(false);
				expect(headers.has('content-length')).toBe(false);
				expect(String(input)).not.toContain(SECRET);
				return jsonResponse(validEnvelope(requestReference));
			}
		);
		const result: PdfSealValidationResult = await validator(fetchMock).validate({
			...requestReference,
			source: byteStream(SOURCE_BYTES, 2),
			sealed: byteStream(SEALED_BYTES, 2)
		});
		expect(result.status).toBe('valid');
		expect('source' in result).toBe(false);
		expect('sealed' in result).toBe(false);
	});

	it('repeats the same validation idempotently with newly opened streams', async () => {
		const requestReference: PdfSealValidationReference = reference();
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(validEnvelope(requestReference))
		);
		const adapter: RemotePdfSealValidator = validator(fetchMock);
		for (let attempt: number = 0; attempt < 2; attempt += 1) {
			const result: PdfSealValidationResult = await adapter.validate({
				...requestReference,
				source: byteStream(SOURCE_BYTES),
				sealed: byteStream(SEALED_BYTES)
			});
			expect(result).toMatchObject({
				status: 'valid',
				validationId: requestReference.validationId,
				validatorReceiptId: 'validator-receipt-01'
			});
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('never accepts a valid response before the complete request frame is consumed', async () => {
		let responseCancelled: boolean = false;
		const responseBody: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			cancel(): void {
				responseCancelled = true;
			}
		});
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(responseBody, {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock, { timeoutMs: 5 }, false).validate(command())
		);
		expectValidatorError(error, { code: 'request_timeout', retryable: true });
		await vi.waitFor((): void => expect(responseCancelled).toBe(true));
	});

	it('requires and echoes the complete B-T TSA tuple and timestamp checks', async () => {
		const requestReference: PdfSealValidationReference = reference({
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
				return jsonResponse(validEnvelope(requestReference));
			}
		);
		const result: PdfSealValidationResult = await validator(fetchMock).validate({
			...requestReference,
			source: byteStream(SOURCE_BYTES),
			sealed: byteStream(SEALED_BYTES)
		});
		expect(result).toMatchObject({
			status: 'valid',
			achievedProfile: 'pades-b-t',
			checks: { timestamp: timestampChecks() }
		});
	});

	it('returns bounded structured invalid findings without a remote message', async () => {
		const requestReference: PdfSealValidationReference = reference();
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse({
				...requestReference,
				status: 'invalid',
				validatorReceiptId: 'validator-receipt-02',
				failureCodes: ['source_prefix_mismatch', 'cms_signature_invalid'],
				message: `${SECRET}: raw engine output`
			})
		);
		const result: PdfSealValidationResult = await validator(fetchMock).validate(command());
		expect(result).toEqual({
			...requestReference,
			status: 'invalid',
			validatorReceiptId: 'validator-receipt-02',
			failureCodes: ['source_prefix_mismatch', 'cms_signature_invalid']
		});
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it.each([
		['sourceSha256', 'e'.repeat(64)],
		['sourceByteSize', SOURCE_BYTES.byteLength + 1],
		['sealedSha256', 'e'.repeat(64)],
		['sealedByteSize', SEALED_BYTES.byteLength + 1],
		['signerCertificateSha256', 'e'.repeat(64)],
		['sealPolicyId', 'other-policy'],
		['validationPolicyId', 'other-validation-policy']
	] as const)('rejects a changed %s echo as an integrity failure', async (field, changed) => {
		const requestReference: PdfSealValidationReference = reference();
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(validEnvelope(requestReference, { [field]: changed }))
		);
		const error: unknown = await capturedError(() => validator(fetchMock).validate(command()));
		expectValidatorError(error, { code: 'integrity_mismatch', retryable: false });
	});

	it('rejects profile substitution without a silent B-T to B-B downgrade', async () => {
		const requestReference: PdfSealValidationReference = reference({
			requestedProfile: 'pades-b-t',
			tsaPolicyId: 'tsa-policy-v1',
			tsaTrustBundleSha256: TRUST_BUNDLE_SHA256
		});
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(validEnvelope(requestReference, { achievedProfile: 'pades-b-b' }))
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock).validate({
				...requestReference,
				source: byteStream(SOURCE_BYTES),
				sealed: byteStream(SEALED_BYTES)
			})
		);
		expectValidatorError(error, { code: 'integrity_mismatch', retryable: false });
	});

	it('requires every successful structural and cryptographic check to be true', async () => {
		const requestReference: PdfSealValidationReference = reference();
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(
				validEnvelope(requestReference, {
					checks: { ...validChecks(), docMdpAbsent: false }
				})
			)
		);
		const error: unknown = await capturedError(() => validator(fetchMock).validate(command()));
		expectValidatorError(error, { code: 'integrity_mismatch', retryable: false });
	});

	it('requires all RFC 3161 policy checks for B-T', async () => {
		const requestReference: PdfSealValidationReference = reference({
			requestedProfile: 'pades-b-t',
			tsaPolicyId: 'tsa-policy-v1',
			tsaTrustBundleSha256: TRUST_BUNDLE_SHA256
		});
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(
				validEnvelope(requestReference, {
					checks: {
						...validChecks(timestampChecks()),
						timestamp: { ...timestampChecks(), ekuCriticalTimeStampingOnly: false }
					}
				})
			)
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock).validate({
				...requestReference,
				source: byteStream(SOURCE_BYTES),
				sealed: byteStream(SEALED_BYTES)
			})
		);
		expectValidatorError(error, { code: 'integrity_mismatch', retryable: false });
	});

	it('rejects timestamp results on B-B and missing timestamp results on B-T', async () => {
		const bb: PdfSealValidationReference = reference();
		const bt: PdfSealValidationReference = reference({
			requestedProfile: 'pades-b-t',
			tsaPolicyId: 'tsa-policy-v1',
			tsaTrustBundleSha256: TRUST_BUNDLE_SHA256
		});
		for (const [requestReference, checks] of [
			[bb, validChecks(timestampChecks())],
			[bt, validChecks(null)]
		] as const) {
			const fetchMock = vi.fn(async (): Promise<Response> =>
				jsonResponse(validEnvelope(requestReference, { checks }))
			);
			const error: unknown = await capturedError(() =>
				validator(fetchMock).validate({
					...requestReference,
					source: byteStream(SOURCE_BYTES),
					sealed: byteStream(SEALED_BYTES)
				})
			);
			expectValidatorError(error, { code: 'integrity_mismatch', retryable: false });
		}
	});

	it.each([
		['source_size_mismatch', SOURCE_BYTES.slice(0, -1), SEALED_BYTES],
		['source_size_mismatch', new Uint8Array([...SOURCE_BYTES, 0]), SEALED_BYTES],
		['sealed_size_mismatch', SOURCE_BYTES, SEALED_BYTES.slice(0, -1)],
		['sealed_size_mismatch', SOURCE_BYTES, new Uint8Array([...SEALED_BYTES, 0])]
	] as const)('rejects %s while streaming exact frames', async (code, source, sealed) => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				await new Response(init?.body as BodyInit).arrayBuffer();
				return jsonResponse(validEnvelope(reference()));
			}
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock).validate(
				command({ source: byteStream(source), sealed: byteStream(sealed) })
			)
		);
		expectValidatorError(error, { code, retryable: false });
	});

	it('preserves frame-size failures when fetch hides the body-stream error', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				try {
					await new Response(init?.body as BodyInit).arrayBuffer();
				} catch {
					throw new TypeError('opaque fetch failure');
				}
				return jsonResponse(validEnvelope(reference()));
			}
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock).validate(command({ source: byteStream(SOURCE_BYTES.slice(0, -1)) }))
		);
		expectValidatorError(error, { code: 'source_size_mismatch', retryable: false });
	});

	it('classifies a source read rejection and cancels the sealed sibling without leaking locks', async () => {
		let sealedCancelled: boolean = false;
		const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.error(new Error(`${SECRET}: source storage read failed`));
			}
		});
		const sealed: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			cancel(): void {
				sealedCancelled = true;
			}
		});
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(validEnvelope(reference()))
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock).validate(command({ source, sealed }))
		);
		expectValidatorError(error, { code: 'network_error', retryable: true });
		expect(sealedCancelled).toBe(true);
		expect(source.locked).toBe(false);
		expect(sealed.locked).toBe(false);
	});

	it('classifies a sealed read rejection and releases both reader locks', async () => {
		const source: ReadableStream<Uint8Array> = byteStream(SOURCE_BYTES, 2);
		const sealed: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.error(new Error(`${SECRET}: sealed storage read failed`));
			}
		});
		const fetchMock = vi.fn(async (): Promise<Response> =>
			jsonResponse(validEnvelope(reference()))
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock).validate(command({ source, sealed }))
		);
		expectValidatorError(error, { code: 'network_error', retryable: true });
		expect(source.locked).toBe(false);
		expect(sealed.locked).toBe(false);
	});

	it.each([
		['http://validator.example.test', SECRET],
		['https://user@validator.example.test', SECRET],
		['https://validator.example.test?next=https://evil.test', SECRET],
		['https://validator.example.test', 'token with space'],
		['https://validator.example.test', 'té']
	])('rejects unsafe configuration without making a request', (baseUrl, bearerToken) => {
		expect(
			() =>
				new RemotePdfSealValidator({
					baseUrl,
					bearerToken,
					maxSealedBytes: 1024
				})
		).toThrowError(PdfSealValidatorError);
	});

	it('rejects source, sealed and TSA input policy violations before fetch', async () => {
		const fetchMock = vi.fn();
		for (const overrides of [
			{ sourceByteSize: 32 * 1024 * 1024 + 1 },
			{ sealedByteSize: SOURCE_BYTES.byteLength },
			{ sealedByteSize: 1024 * 1024 + 1 },
			{ requestedProfile: 'pades-b-t' as const },
			{ tsaPolicyId: 'unexpected', tsaTrustBundleSha256: TRUST_BUNDLE_SHA256 }
		]) {
			const error: unknown = await capturedError(() =>
				validator(fetchMock).validate(command(overrides))
			);
			expectValidatorError(error, { code: 'invalid_request', retryable: false });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('cancels both streams when frozen metadata fails preflight', async () => {
		const cancelled: { source: boolean; sealed: boolean } = { source: false, sealed: false };
		const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			cancel(): void {
				cancelled.source = true;
			}
		});
		const sealed: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			cancel(): void {
				cancelled.sealed = true;
			}
		});
		const fetchMock = vi.fn();
		const error: unknown = await capturedError(() =>
			validator(fetchMock).validate(command({ sourceSha256: 'not-a-digest', source, sealed }))
		);
		expectValidatorError(error, { code: 'invalid_request', retryable: false });
		expect(cancelled).toEqual({ source: true, sealed: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects duplicate, unknown, empty, or excessive failure codes', async () => {
		const requestReference: PdfSealValidationReference = reference();
		for (const failureCodes of [
			[],
			['cms_signature_invalid', 'cms_signature_invalid'],
			['raw_engine_exception'],
			Array.from({ length: 33 }, (): string => 'cms_signature_invalid')
		]) {
			const fetchMock = vi.fn(async (): Promise<Response> =>
				jsonResponse({
					...requestReference,
					status: 'invalid',
					validatorReceiptId: 'receipt-01',
					failureCodes
				})
			);
			const error: unknown = await capturedError(() => validator(fetchMock).validate(command()));
			expectValidatorError(error, { code: 'invalid_response', retryable: false });
		}
	});

	it.each([
		[408, 'request_timeout', true],
		[425, 'rate_limited', true],
		[429, 'rate_limited', true],
		[500, 'validator_unavailable', true],
		[503, 'validator_unavailable', true],
		[401, 'validator_authentication_failed', false],
		[403, 'validator_authentication_failed', false],
		[409, 'validation_conflict', false],
		[422, 'validator_rejected', false]
	] as const)('classifies HTTP %s as %s', async (status, code, retryable) => {
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(`${SECRET}: remote failure`, {
					status,
					headers: { 'content-type': 'text/plain' }
				})
		);
		const error: unknown = await capturedError(() => validator(fetchMock).validate(command()));
		expectValidatorError(error, { code, retryable, httpStatus: status });
	});

	it.each([
		[401, 'validator_authentication_failed', false],
		[409, 'validation_conflict', false],
		[429, 'rate_limited', true]
	] as const)(
		'classifies fast HTTP %s before an unconsumed upload can time out',
		async (status, code, retryable) => {
			const cancelled: { source: boolean; sealed: boolean } = { source: false, sealed: false };
			const source: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
				cancel(): void {
					cancelled.source = true;
				}
			});
			const sealed: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
				cancel(): void {
					cancelled.sealed = true;
				}
			});
			const fetchMock = vi.fn(
				async (): Promise<Response> =>
					new Response('bounded error', {
						status,
						headers: { 'content-type': 'text/plain' }
					})
			);
			const error: unknown = await capturedError(() =>
				validator(fetchMock, { timeoutMs: 5 }, false).validate(command({ source, sealed }))
			);
			expectValidatorError(error, { code, retryable, httpStatus: status });
			await vi.waitFor((): void => expect(cancelled).toEqual({ source: true, sealed: true }));
			expect(source.locked).toBe(false);
			expect(sealed.locked).toBe(false);
		}
	);

	it('uses real fetch manual semantics and never follows redirects', async () => {
		const redirectServer: RedirectTestServer = await startRedirectTestServer();
		try {
			const adapter: RemotePdfSealValidator = validator(
				async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
					fetch(`${redirectServer.origin}/redirect`, init),
				{},
				false
			);
			const error: unknown = await capturedError(() => adapter.validate(command()));
			expectValidatorError(error, {
				code: 'validator_redirected',
				retryable: false,
				httpStatus: 307
			});
			expect(redirectServer.counts).toEqual({ redirect: 1, followed: 0 });
		} finally {
			await redirectServer.close();
		}
	});

	it('rejects oversized, compressed, wrong-type, and malformed JSON responses', async () => {
		const responses: readonly [() => Response, PdfSealValidatorError['code']][] = [
			[
				() =>
					new Response(new Uint8Array(64 * 1024 + 1), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					}),
				'response_too_large'
			],
			[
				() =>
					new Response('{}', {
						status: 200,
						headers: {
							'content-type': 'application/json',
							'content-length': String(64 * 1024 + 1)
						}
					}),
				'response_too_large'
			],
			[
				() =>
					new Response('{}', {
						status: 200,
						headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }
					}),
				'invalid_response'
			],
			[
				() => new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
				'invalid_response'
			],
			[
				() => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
				'invalid_response'
			],
			[
				() =>
					new Response(new Uint8Array([0xff]), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					}),
				'invalid_response'
			]
		];
		for (const [makeResponse, code] of responses) {
			const fetchMock = vi.fn(async (): Promise<Response> => makeResponse());
			const error: unknown = await capturedError(() => validator(fetchMock).validate(command()));
			expectValidatorError(error, { code, retryable: false });
		}
	});

	it('treats a declared JSON length mismatch as malformed rather than tampering', async () => {
		const body: string = JSON.stringify(validEnvelope(reference()));
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(body, {
					status: 200,
					headers: {
						'content-type': 'application/json',
						'content-length': String(new TextEncoder().encode(body).byteLength + 1)
					}
				})
		);
		const error: unknown = await capturedError(() => validator(fetchMock).validate(command()));
		expectValidatorError(error, { code: 'invalid_response', retryable: false });
	});

	it('rejects malformed validator receipts and already-followed responses', async () => {
		const malformedReceipt = vi.fn(async (): Promise<Response> =>
			jsonResponse(validEnvelope(reference(), { validatorReceiptId: 'unsafe receipt' }))
		);
		let error: unknown = await capturedError(() => validator(malformedReceipt).validate(command()));
		expectValidatorError(error, { code: 'invalid_response', retryable: false });

		const followed: Response = jsonResponse(validEnvelope(reference()));
		Object.defineProperty(followed, 'redirected', { value: true });
		const redirected = vi.fn(async (): Promise<Response> => followed);
		error = await capturedError(() => validator(redirected).validate(command()));
		expectValidatorError(error, {
			code: 'validator_redirected',
			retryable: false,
			httpStatus: 200
		});
	});

	it('classifies transport and timeout failures without exposing remote detail', async () => {
		for (const [errorName, code] of [
			['Error', 'network_error'],
			['TimeoutError', 'request_timeout']
		] as const) {
			const fetchMock = vi.fn(async (): Promise<Response> => {
				const error: Error = new Error(`${SECRET}: https://private.validator.test`);
				error.name = errorName;
				throw error;
			});
			const error: unknown = await capturedError(() => validator(fetchMock).validate(command()));
			expectValidatorError(error, { code, retryable: true });
		}
	});

	it('classifies a post-header AbortError as timeout when the request signal expires', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				await new Response(init?.body as BodyInit).arrayBuffer();
				const signal: AbortSignal = init?.signal as AbortSignal;
				const responseBody: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
					pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
						return new Promise<void>((resolve: () => void): void => {
							const fail = (): void => {
								const error: Error = new Error(`${SECRET}: response body aborted`);
								error.name = 'AbortError';
								controller.error(error);
								resolve();
							};
							if (signal.aborted) fail();
							else signal.addEventListener('abort', fail, { once: true });
						});
					}
				});
				return new Response(responseBody, {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		);
		const error: unknown = await capturedError(() =>
			validator(fetchMock, { timeoutMs: 5 }).validate(command())
		);
		expectValidatorError(error, { code: 'request_timeout', retryable: true });
	});
});
