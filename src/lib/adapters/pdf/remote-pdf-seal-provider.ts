import {
	PdfSealProviderError,
	type PdfSealOperationReference,
	type PdfSealProfile,
	type PdfSealProvider,
	type PdfSealProviderOperation,
	type PdfSealResult,
	type PdfSealSucceededOperation,
	type SubmitPdfSealOperation
} from '$lib/ports/pdf-seal-provider';

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
const MAX_PROVIDER_JSON_BYTES: number = 64 * 1024;
const MAX_PROVIDER_ERROR_BYTES: number = 16 * 1024;
const MAX_CONFIGURED_RESULT_BYTES: number = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: number = 20_000;
const MAX_TIMEOUT_MS: number = 60_000;

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RemotePdfSealProviderOptions {
	baseUrl: string;
	bearerToken: string;
	/** Deployment policy chooses the actual ceiling; the adapter caps it at 64 MiB. */
	maxResultBytes: number;
	timeoutMs?: number;
	fetch?: FetchImplementation;
}

interface ProviderOperationEnvelope {
	operationId?: unknown;
	status?: unknown;
	sourceSha256?: unknown;
	sourceByteSize?: unknown;
	requestedProfile?: unknown;
	signerCertificateSha256?: unknown;
	sealPolicyId?: unknown;
	validationPolicyId?: unknown;
	tsaPolicyId?: unknown;
	tsaTrustBundleSha256?: unknown;
	providerReceiptId?: unknown;
	errorCode?: unknown;
	retryable?: unknown;
	achievedProfile?: unknown;
	resultSha256?: unknown;
	resultByteSize?: unknown;
}

/**
 * Worker-compatible remote signer transport. It never accepts a provider-
 * supplied URL: all three endpoints are derived from one validated base URL
 * and the caller's stable operation ID.
 */
export class RemotePdfSealProvider implements PdfSealProvider {
	readonly #baseUrl: string;
	readonly #bearerToken: string;
	readonly #maxResultBytes: number;
	readonly #timeoutMs: number;
	readonly #fetch: FetchImplementation;

	constructor(options: RemotePdfSealProviderOptions) {
		this.#baseUrl = normalizeBaseUrl(options.baseUrl);
		this.#bearerToken = validateBearerToken(options.bearerToken);
		this.#maxResultBytes = validateIntegerRange(
			options.maxResultBytes,
			1,
			MAX_CONFIGURED_RESULT_BYTES,
			'invalid_configuration'
		);
		this.#timeoutMs = validateIntegerRange(
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			1,
			MAX_TIMEOUT_MS,
			'invalid_configuration'
		);
		this.#fetch = options.fetch ?? fetch;
	}

	async submit(command: SubmitPdfSealOperation): Promise<PdfSealProviderOperation> {
		const reference: PdfSealOperationReference = normalizedOperationReference(command);
		if (!isReadableByteStream(command.source)) {
			throw providerError('invalid_request', false, false);
		}
		const response: Response = await this.#performFetch(
			this.#operationUrl(reference.operationId),
			{
				method: 'PUT',
				redirect: 'error',
				signal: AbortSignal.timeout(this.#timeoutMs),
				headers: this.#headers(reference, true),
				body: exactLengthStream(command.source, reference.sourceByteSize),
				// Required by Node's standards-based fetch for streaming request bodies;
				// ignored by Workers, whose fetch accepts the same ReadableStream body.
				duplex: 'half'
			} as RequestInit & { duplex: 'half' },
			true
		);
		return this.#readOperationResponse(response, reference, true);
	}

	async getStatus(reference: PdfSealOperationReference): Promise<PdfSealProviderOperation> {
		const normalized: PdfSealOperationReference = normalizedOperationReference(reference);
		const response: Response = await this.#performFetch(
			this.#operationUrl(normalized.operationId),
			{
				method: 'GET',
				redirect: 'error',
				signal: AbortSignal.timeout(this.#timeoutMs),
				headers: this.#headers(normalized, false)
			},
			false
		);
		return this.#readOperationResponse(response, normalized, false);
	}

	async readResult(operation: PdfSealSucceededOperation): Promise<PdfSealResult> {
		assertSucceededOperation(operation, this.#maxResultBytes);
		const response: Response = await this.#performFetch(
			`${this.#operationUrl(operation.operationId)}/result`,
			{
				method: 'GET',
				redirect: 'error',
				signal: AbortSignal.timeout(this.#timeoutMs),
				headers: this.#headers(operation, false, 'application/pdf')
			},
			false
		);
		await assertSuccessfulResponse(response, false);
		if (mediaType(response.headers.get('content-type')) !== 'application/pdf') {
			await discardBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
			throw providerError('invalid_response', false, false);
		}
		const contentEncoding: string | null = response.headers.get('content-encoding');
		if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
			await discardBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
			throw providerError('invalid_response', false, false);
		}
		let declaredLength: number;
		try {
			assertResultHeaders(response.headers, operation);
			declaredLength = parseRequiredLength(response.headers.get('content-length'));
			if (declaredLength !== operation.resultByteSize) {
				throw providerError('integrity_mismatch', false, false);
			}
		} catch (error: unknown) {
			await discardBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
			if (error instanceof PdfSealProviderError) throw error;
			throw providerError('invalid_response', false, false);
		}
		const bytes: Uint8Array<ArrayBuffer> = await readExactBody(response.body, declaredLength);
		const digest: string = await sha256Hex(bytes);
		if (digest !== operation.resultSha256) {
			throw providerError('integrity_mismatch', false, false);
		}
		return {
			bytes,
			sha256: digest,
			byteSize: bytes.byteLength,
			achievedProfile: operation.achievedProfile,
			providerReceiptId: operation.providerReceiptId
		};
	}

	#operationUrl(operationId: string): string {
		return `${this.#baseUrl}/pdf-seals/${encodeURIComponent(operationId)}`;
	}

	#headers(
		reference: PdfSealOperationReference,
		includeContentType: boolean,
		accept: string = 'application/json'
	): Headers {
		const headers: Headers = new Headers({
			accept,
			authorization: `Bearer ${this.#bearerToken}`,
			'idempotency-key': reference.operationId,
			'x-signkit-operation-id': reference.operationId,
			'x-signkit-requested-profile': reference.requestedProfile,
			'x-signkit-seal-policy-id': reference.sealPolicyId,
			'x-signkit-signer-certificate-sha256': reference.signerCertificateSha256,
			'x-signkit-source-byte-size': String(reference.sourceByteSize),
			'x-signkit-source-sha256': reference.sourceSha256,
			'x-signkit-validation-policy-id': reference.validationPolicyId
		});
		if (includeContentType) {
			headers.set('content-type', 'application/pdf');
			// Workers ignores a manually supplied Content-Length for an ordinary
			// ReadableStream and uses chunked encoding. The signed size travels in
			// x-signkit-source-byte-size and exactLengthStream enforces it locally.
		}
		if (reference.tsaPolicyId !== null) {
			headers.set('x-signkit-tsa-policy-id', reference.tsaPolicyId);
		}
		if (reference.tsaTrustBundleSha256 !== null) {
			headers.set('x-signkit-tsa-trust-bundle-sha256', reference.tsaTrustBundleSha256);
		}
		return headers;
	}

	async #performFetch(url: string, init: RequestInit, ambiguous: boolean): Promise<Response> {
		try {
			return await this.#fetch(url, init);
		} catch (error: unknown) {
			if (error instanceof PdfSealProviderError) throw error;
			const cause: unknown = errorCause(error);
			if (cause instanceof PdfSealProviderError) throw cause;
			throw providerError(
				isTimeoutError(error) ? 'request_timeout' : 'network_error',
				true,
				ambiguous
			);
		}
	}

	async #readOperationResponse(
		response: Response,
		reference: PdfSealOperationReference,
		ambiguous: boolean
	): Promise<PdfSealProviderOperation> {
		await assertSuccessfulResponse(response, ambiguous);
		if (mediaType(response.headers.get('content-type')) !== 'application/json') {
			await discardBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
			throw providerError('invalid_response', false, ambiguous);
		}
		const contentEncoding: string | null = response.headers.get('content-encoding');
		if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
			await discardBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
			throw providerError('invalid_response', false, ambiguous);
		}
		const body: Uint8Array<ArrayBuffer> = await readBoundedBody(
			response.body,
			response.headers.get('content-length'),
			MAX_PROVIDER_JSON_BYTES,
			ambiguous
		);
		let envelope: ProviderOperationEnvelope;
		try {
			const decoded: string = new TextDecoder('utf-8', { fatal: true }).decode(body);
			const parsed: unknown = JSON.parse(decoded);
			if (!isRecord(parsed)) throw new Error('not an object');
			envelope = parsed;
		} catch {
			throw providerError('invalid_response', false, ambiguous);
		}
		return parseOperationEnvelope(envelope, reference, this.#maxResultBytes, ambiguous);
	}
}

function normalizeBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw providerError('invalid_configuration', false, false);
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.hostname.length === 0
	) {
		throw providerError('invalid_configuration', false, false);
	}
	const pathname: string = url.pathname.replace(/\/+$/, '');
	url.pathname = pathname === '' ? '/' : pathname;
	return url.toString().replace(/\/$/, '');
}

function validateBearerToken(value: string): string {
	if (
		typeof value !== 'string' ||
		value.length < 1 ||
		value.length > 4096 ||
		value !== value.trim() ||
		Array.from(value).some((character: string): boolean => {
			const codePoint: number = character.codePointAt(0) ?? 0;
			return codePoint <= 0x20 || codePoint === 0x7f;
		})
	) {
		throw providerError('invalid_configuration', false, false);
	}
	return value;
}

function assertOperationReference(reference: PdfSealOperationReference): void {
	assertSafeIdentifier(reference.operationId);
	assertSha256(reference.sourceSha256);
	validateIntegerRange(reference.sourceByteSize, 1, Number.MAX_SAFE_INTEGER, 'invalid_request');
	assertProfile(reference.requestedProfile);
	assertSha256(reference.signerCertificateSha256);
	assertSafeIdentifier(reference.sealPolicyId);
	assertSafeIdentifier(reference.validationPolicyId);
	if (reference.requestedProfile === 'pades-b-t') {
		if (reference.tsaPolicyId === null || reference.tsaTrustBundleSha256 === null) {
			throw providerError('invalid_request', false, false);
		}
		assertSafeIdentifier(reference.tsaPolicyId);
		assertSha256(reference.tsaTrustBundleSha256);
	} else if (reference.tsaPolicyId !== null || reference.tsaTrustBundleSha256 !== null) {
		throw providerError('invalid_request', false, false);
	}
}

/** Drop extra runtime properties such as the submit-only source stream. */
function normalizedOperationReference(
	reference: PdfSealOperationReference
): PdfSealOperationReference {
	assertOperationReference(reference);
	return {
		operationId: reference.operationId,
		sourceSha256: reference.sourceSha256,
		sourceByteSize: reference.sourceByteSize,
		requestedProfile: reference.requestedProfile,
		signerCertificateSha256: reference.signerCertificateSha256,
		sealPolicyId: reference.sealPolicyId,
		validationPolicyId: reference.validationPolicyId,
		tsaPolicyId: reference.tsaPolicyId,
		tsaTrustBundleSha256: reference.tsaTrustBundleSha256
	};
}

function assertSucceededOperation(
	operation: PdfSealSucceededOperation,
	maxResultBytes: number
): void {
	assertOperationReference(operation);
	if (operation.status !== 'succeeded') throw providerError('invalid_request', false, false);
	assertSafeIdentifier(operation.providerReceiptId);
	assertProfile(operation.achievedProfile);
	if (operation.achievedProfile !== operation.requestedProfile) {
		throw providerError('invalid_request', false, false);
	}
	assertSha256(operation.resultSha256);
	validateIntegerRange(operation.resultByteSize, 1, maxResultBytes, 'invalid_request');
	if (operation.resultByteSize <= operation.sourceByteSize) {
		throw providerError('invalid_request', false, false);
	}
}

function parseOperationEnvelope(
	envelope: ProviderOperationEnvelope,
	reference: PdfSealOperationReference,
	maxResultBytes: number,
	ambiguous: boolean
): PdfSealProviderOperation {
	assertEcho(envelope, reference, ambiguous);
	const providerReceiptId: string = requireSafeIdentifier(envelope.providerReceiptId, ambiguous);
	if (envelope.status === 'pending' || envelope.status === 'processing') {
		return { ...reference, status: envelope.status, providerReceiptId };
	}
	if (envelope.status === 'failed') {
		if (
			typeof envelope.errorCode !== 'string' ||
			!SAFE_ERROR_CODE_PATTERN.test(envelope.errorCode) ||
			typeof envelope.retryable !== 'boolean'
		) {
			throw providerError('invalid_response', false, ambiguous);
		}
		return {
			...reference,
			status: 'failed',
			providerReceiptId,
			errorCode: envelope.errorCode,
			retryable: envelope.retryable
		};
	}
	if (envelope.status !== 'succeeded') {
		throw providerError('invalid_response', false, ambiguous);
	}
	assertProfileResponse(envelope.achievedProfile, ambiguous);
	if (envelope.achievedProfile !== reference.requestedProfile) {
		throw providerError('integrity_mismatch', false, ambiguous);
	}
	if (typeof envelope.resultSha256 !== 'string' || !SHA256_PATTERN.test(envelope.resultSha256)) {
		throw providerError('invalid_response', false, ambiguous);
	}
	const resultByteSize: number = requireInteger(
		envelope.resultByteSize,
		1,
		Number.MAX_SAFE_INTEGER,
		ambiguous
	);
	if (resultByteSize > maxResultBytes) {
		throw providerError('response_too_large', false, ambiguous);
	}
	if (resultByteSize <= reference.sourceByteSize) {
		throw providerError('integrity_mismatch', false, ambiguous);
	}
	return {
		...reference,
		status: 'succeeded',
		providerReceiptId,
		achievedProfile: envelope.achievedProfile,
		resultSha256: envelope.resultSha256,
		resultByteSize
	};
}

function assertEcho(
	envelope: ProviderOperationEnvelope,
	reference: PdfSealOperationReference,
	ambiguous: boolean
): void {
	if (
		envelope.operationId !== reference.operationId ||
		envelope.sourceSha256 !== reference.sourceSha256 ||
		envelope.sourceByteSize !== reference.sourceByteSize ||
		envelope.requestedProfile !== reference.requestedProfile ||
		envelope.signerCertificateSha256 !== reference.signerCertificateSha256 ||
		envelope.sealPolicyId !== reference.sealPolicyId ||
		envelope.validationPolicyId !== reference.validationPolicyId ||
		envelope.tsaPolicyId !== reference.tsaPolicyId ||
		envelope.tsaTrustBundleSha256 !== reference.tsaTrustBundleSha256
	) {
		throw providerError('integrity_mismatch', false, ambiguous);
	}
}

async function assertSuccessfulResponse(response: Response, ambiguous: boolean): Promise<void> {
	if (response.redirected) {
		await discardBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
		throw providerError('provider_redirected', false, ambiguous, response.status);
	}
	if (response.status >= 200 && response.status < 300) return;
	await discardBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
	if (response.status >= 300 && response.status < 400) {
		throw providerError('provider_redirected', false, false, response.status);
	}
	if (response.status === 408) {
		throw providerError('request_timeout', true, false, response.status);
	}
	if (response.status === 425 || response.status === 429) {
		throw providerError('rate_limited', true, false, response.status);
	}
	if (response.status >= 500) {
		throw providerError('provider_unavailable', true, ambiguous, response.status);
	}
	if (response.status === 401 || response.status === 403) {
		throw providerError('provider_authentication_failed', false, false, response.status);
	}
	if (response.status === 404) {
		throw providerError('operation_not_found', false, false, response.status);
	}
	if (response.status === 409) {
		throw providerError('operation_conflict', false, false, response.status);
	}
	throw providerError('provider_rejected', false, false, response.status);
}

function assertResultHeaders(headers: Headers, operation: PdfSealSucceededOperation): void {
	const expected: Readonly<Record<string, string>> = {
		'x-signkit-operation-id': operation.operationId,
		'x-signkit-provider-receipt-id': operation.providerReceiptId,
		'x-signkit-source-sha256': operation.sourceSha256,
		'x-signkit-source-byte-size': String(operation.sourceByteSize),
		'x-signkit-requested-profile': operation.requestedProfile,
		'x-signkit-achieved-profile': operation.achievedProfile,
		'x-signkit-signer-certificate-sha256': operation.signerCertificateSha256,
		'x-signkit-seal-policy-id': operation.sealPolicyId,
		'x-signkit-validation-policy-id': operation.validationPolicyId,
		'x-signkit-result-sha256': operation.resultSha256
	};
	for (const [name, value] of Object.entries(expected)) {
		if (headers.get(name) !== value) throw providerError('integrity_mismatch', false, false);
	}
	if (operation.tsaPolicyId === null) {
		if (
			headers.has('x-signkit-tsa-policy-id') ||
			headers.has('x-signkit-tsa-trust-bundle-sha256')
		) {
			throw providerError('integrity_mismatch', false, false);
		}
	} else if (
		headers.get('x-signkit-tsa-policy-id') !== operation.tsaPolicyId ||
		headers.get('x-signkit-tsa-trust-bundle-sha256') !== operation.tsaTrustBundleSha256
	) {
		throw providerError('integrity_mismatch', false, false);
	}
}

function exactLengthStream(
	source: ReadableStream<Uint8Array>,
	expectedSize: number
): ReadableStream<Uint8Array> {
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = source.getReader();
	} catch {
		throw providerError('invalid_request', false, false);
	}
	let seen: number = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) {
				if (seen !== expectedSize) {
					controller.error(providerError('source_size_mismatch', false, false));
					return;
				}
				controller.close();
				return;
			}
			seen += result.value.byteLength;
			if (seen > expectedSize) {
				try {
					await reader.cancel('source_size_mismatch');
				} catch {
					// The size mismatch remains authoritative.
				}
				controller.error(providerError('source_size_mismatch', false, false));
				return;
			}
			controller.enqueue(result.value);
		},
		async cancel(reason: unknown): Promise<void> {
			try {
				await reader.cancel(reason);
			} catch {
				// Cancellation is best effort after the request has ended.
			}
		}
	});
}

async function readBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	contentLength: string | null,
	maxBytes: number,
	ambiguous: boolean
): Promise<Uint8Array<ArrayBuffer>> {
	if (body === null) throw providerError('invalid_response', false, ambiguous);
	let declaredLength: number | null;
	try {
		declaredLength = parseOptionalLength(contentLength, ambiguous);
	} catch (error: unknown) {
		await discardBoundedBody(body, MAX_PROVIDER_ERROR_BYTES);
		if (error instanceof PdfSealProviderError) throw error;
		throw providerError('invalid_response', false, ambiguous);
	}
	if (declaredLength !== null && declaredLength > maxBytes) {
		await discardBoundedBody(body, MAX_PROVIDER_ERROR_BYTES);
		throw providerError('response_too_large', false, ambiguous);
	}
	const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
	const chunks: Uint8Array[] = [];
	let total: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) {
				try {
					await reader.cancel('response_too_large');
				} catch {
					// The bounded-read failure remains authoritative.
				}
				throw providerError('response_too_large', false, ambiguous);
			}
			chunks.push(result.value);
		}
	} catch (error: unknown) {
		if (error instanceof PdfSealProviderError) throw error;
		throw providerError(
			isTimeoutError(error) ? 'request_timeout' : 'network_error',
			true,
			ambiguous
		);
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore lock release failure.
		}
	}
	if (declaredLength !== null && total !== declaredLength) {
		throw providerError('integrity_mismatch', false, ambiguous);
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(total));
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function readExactBody(
	body: ReadableStream<Uint8Array> | null,
	expectedSize: number
): Promise<Uint8Array<ArrayBuffer>> {
	if (body === null) throw providerError('invalid_response', false, false);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(expectedSize));
	const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
	let offset: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			if (result.value.byteLength > expectedSize - offset) {
				try {
					await reader.cancel('integrity_mismatch');
				} catch {
					// The integrity failure remains authoritative.
				}
				throw providerError('integrity_mismatch', false, false);
			}
			bytes.set(result.value, offset);
			offset += result.value.byteLength;
		}
	} catch (error: unknown) {
		if (error instanceof PdfSealProviderError) throw error;
		throw providerError(isTimeoutError(error) ? 'request_timeout' : 'network_error', true, false);
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore lock release failure.
		}
	}
	if (offset !== expectedSize) throw providerError('integrity_mismatch', false, false);
	return bytes;
}

async function discardBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number
): Promise<void> {
	if (body === null) return;
	const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
	let total: number = 0;
	try {
		while (total <= maxBytes) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) return;
			total += result.value.byteLength;
		}
		try {
			await reader.cancel('error_body_limit_reached');
		} catch {
			// Error response disposal is best effort.
		}
	} catch {
		// The HTTP status remains authoritative when disposal fails.
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore lock release failure.
		}
	}
}

function parseOptionalLength(value: string | null, ambiguous: boolean = false): number | null {
	if (value === null) return null;
	if (!/^(0|[1-9][0-9]*)$/.test(value)) {
		throw providerError('invalid_response', false, ambiguous);
	}
	const parsed: number = Number(value);
	if (!Number.isSafeInteger(parsed)) throw providerError('invalid_response', false, ambiguous);
	return parsed;
}

function parseRequiredLength(value: string | null): number {
	const parsed: number | null = parseOptionalLength(value);
	if (parsed === null) throw providerError('invalid_response', false, false);
	return parsed;
}

function mediaType(value: string | null): string | null {
	if (value === null) return null;
	return value.split(';', 1)[0]?.trim().toLowerCase() ?? null;
}

function isRecord(value: unknown): value is ProviderOperationEnvelope {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'getReader' in value &&
		typeof value.getReader === 'function'
	);
}

function errorCause(error: unknown): unknown {
	if (typeof error !== 'object' || error === null || !('cause' in error)) return null;
	return error.cause;
}

function isTimeoutError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error.name === 'TimeoutError' || error.name === 'AbortError')
	);
}

function assertProfile(value: unknown): asserts value is PdfSealProfile {
	if (value !== 'pades-b-b' && value !== 'pades-b-t') {
		throw providerError('invalid_request', false, false);
	}
}

function assertProfileResponse(
	value: unknown,
	ambiguous: boolean
): asserts value is PdfSealProfile {
	if (value !== 'pades-b-b' && value !== 'pades-b-t') {
		throw providerError('invalid_response', false, ambiguous);
	}
}

function assertSha256(value: string): void {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
		throw providerError('invalid_request', false, false);
	}
}

function assertSafeIdentifier(value: string): void {
	if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
		throw providerError('invalid_request', false, false);
	}
}

function requireSafeIdentifier(value: unknown, ambiguous: boolean): string {
	if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
		throw providerError('invalid_response', false, ambiguous);
	}
	return value;
}

function requireInteger(
	value: unknown,
	minimum: number,
	maximum: number,
	ambiguous: boolean
): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		throw providerError('invalid_response', false, ambiguous);
	}
	return value;
}

function validateIntegerRange(
	value: number,
	minimum: number,
	maximum: number,
	code: 'invalid_configuration' | 'invalid_request'
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw providerError(code, false, false);
	}
	return value;
}

function providerError(
	code: PdfSealProviderError['code'],
	retryable: boolean,
	ambiguous: boolean,
	httpStatus: number | null = null
): PdfSealProviderError {
	return new PdfSealProviderError(code, retryable, ambiguous, httpStatus);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
