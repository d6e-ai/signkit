import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import {
	PdfSealValidatorError,
	type PdfSealTimestampChecks,
	type PdfSealValidationChecks,
	type PdfSealValidationFailureCode,
	type PdfSealValidationReference,
	type PdfSealValidationResult,
	type PdfSealValidator,
	type ValidatePdfSealCommand
} from '$lib/ports/pdf-seal-validator';
import type { PdfSealProfile } from '$lib/ports/pdf-seal-provider';

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BEARER_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9\-._~+/]+=*$/;
const MAX_VALIDATOR_JSON_BYTES: number = 64 * 1024;
const MAX_VALIDATOR_ERROR_BYTES: number = 16 * 1024;
const MAX_CONFIGURED_SEALED_BYTES: number = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: number = 60_000;
const MAX_TIMEOUT_MS: number = 120_000;
const REQUEST_MEDIA_TYPE: string = 'application/vnd.signkit.pdf-seal-validation-v1';
const FAILURE_CODES: ReadonlySet<string> = new Set<PdfSealValidationFailureCode>([
	'source_prefix_mismatch',
	'incremental_update_invalid',
	'byte_range_invalid',
	'cms_signature_invalid',
	'cms_profile_invalid',
	'signer_certificate_unprotected',
	'signer_certificate_mismatch',
	'certificate_path_invalid',
	'seal_policy_rejected',
	'approval_signature_invalid',
	'doc_mdp_forbidden',
	'post_seal_changes_detected',
	'timestamp_missing',
	'timestamp_response_rejected',
	'timestamp_imprint_mismatch',
	'timestamp_nonce_mismatch',
	'timestamp_policy_mismatch',
	'timestamp_signature_invalid',
	'timestamp_trust_invalid',
	'timestamp_eku_invalid',
	'timestamp_ess_binding_invalid',
	'timestamp_time_invalid',
	'unsupported_algorithm'
]);

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RemotePdfSealValidatorOptions {
	baseUrl: string;
	bearerToken: string;
	/** Caps the sealed PDF after its incremental update; hard maximum is 64 MiB. */
	maxSealedBytes: number;
	timeoutMs?: number;
	fetch?: FetchImplementation;
}

interface ValidationEnvelope {
	validationId?: unknown;
	operationId?: unknown;
	status?: unknown;
	sourceSha256?: unknown;
	sourceByteSize?: unknown;
	sealedSha256?: unknown;
	sealedByteSize?: unknown;
	requestedProfile?: unknown;
	achievedProfile?: unknown;
	signerCertificateSha256?: unknown;
	sealPolicyId?: unknown;
	validationPolicyId?: unknown;
	tsaPolicyId?: unknown;
	tsaTrustBundleSha256?: unknown;
	validatorReceiptId?: unknown;
	checks?: unknown;
	failureCodes?: unknown;
}

interface FramedValidationBody {
	stream: ReadableStream<Uint8Array>;
	completed: Promise<void>;
	failure(): PdfSealValidatorError | null;
	cancel(error: PdfSealValidatorError): Promise<void>;
}

/**
 * Worker-compatible transport to an independently trusted PDF validator.
 * The request body is exactly source bytes followed by sealed bytes; the two
 * frozen lengths provide the frame without base64 or multipart buffering.
 */
export class RemotePdfSealValidator implements PdfSealValidator {
	readonly #baseUrl: string;
	readonly #bearerToken: string;
	readonly #maxSealedBytes: number;
	readonly #timeoutMs: number;
	readonly #fetch: FetchImplementation;

	constructor(options: RemotePdfSealValidatorOptions) {
		this.#baseUrl = normalizeBaseUrl(options.baseUrl);
		this.#bearerToken = validateBearerToken(options.bearerToken);
		this.#maxSealedBytes = validateIntegerRange(
			options.maxSealedBytes,
			1,
			MAX_CONFIGURED_SEALED_BYTES,
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

	async validate(command: ValidatePdfSealCommand): Promise<PdfSealValidationResult> {
		if (!isReadableByteStream(command.source) || !isReadableByteStream(command.sealed)) {
			await cancelReadableStream(command.source, 'invalid_request');
			await cancelReadableStream(command.sealed, 'invalid_request');
			throw validatorError('invalid_request', false);
		}
		let reference: PdfSealValidationReference;
		try {
			reference = normalizedReference(command, this.#maxSealedBytes);
		} catch (error: unknown) {
			await Promise.all([
				cancelReadableStream(command.source, 'invalid_request'),
				cancelReadableStream(command.sealed, 'invalid_request')
			]);
			throw error;
		}
		const timeoutSignal: AbortSignal = AbortSignal.timeout(this.#timeoutMs);
		let framedBody: FramedValidationBody;
		try {
			framedBody = framedValidationStream(
				command.source,
				command.sealed,
				reference.sourceByteSize,
				reference.sealedByteSize,
				timeoutSignal
			);
		} catch (error: unknown) {
			await Promise.all([
				cancelReadableStream(command.source, 'invalid_request'),
				cancelReadableStream(command.sealed, 'invalid_request')
			]);
			throw error;
		}
		let response: Response;
		try {
			response = await this.#performFetch(
				this.#validationUrl(reference.validationId),
				{
					method: 'PUT',
					redirect: 'manual',
					signal: timeoutSignal,
					headers: this.#headers(reference),
					body: framedBody.stream,
					duplex: 'half'
				} as RequestInit & { duplex: 'half' },
				framedBody.failure,
				timeoutSignal
			);
		} catch (error: unknown) {
			const classified: PdfSealValidatorError = classifyTransportError(error, timeoutSignal);
			void framedBody.cancel(classified);
			throw classified;
		}
		const redirectFailure: PdfSealValidatorError | null = responseRedirectFailure(response);
		if (redirectFailure !== null) {
			void framedBody.cancel(redirectFailure);
			cancelBodyBestEffort(response.body, redirectFailure.code);
			throw redirectFailure;
		}
		if (!response.ok) {
			void framedBody.cancel(validatorError('validator_rejected', false));
			return this.#readValidationResponse(response, reference, timeoutSignal);
		}
		try {
			await waitForFrameCompletion(framedBody, timeoutSignal);
		} catch (error: unknown) {
			const classified: PdfSealValidatorError = classifyTransportError(error, timeoutSignal);
			void framedBody.cancel(classified);
			cancelBodyBestEffort(response.body, classified.code);
			throw classified;
		}
		return this.#readValidationResponse(response, reference, timeoutSignal);
	}

	#validationUrl(validationId: string): string {
		return `${this.#baseUrl}/pdf-seal-validations/${encodeURIComponent(validationId)}`;
	}

	#headers(reference: PdfSealValidationReference): Headers {
		const headers: Headers = new Headers({
			accept: 'application/json',
			'accept-encoding': 'identity',
			authorization: `Bearer ${this.#bearerToken}`,
			'content-type': REQUEST_MEDIA_TYPE,
			'idempotency-key': reference.validationId,
			'x-signkit-operation-id': reference.operationId,
			'x-signkit-requested-profile': reference.requestedProfile,
			'x-signkit-seal-policy-id': reference.sealPolicyId,
			'x-signkit-sealed-byte-size': String(reference.sealedByteSize),
			'x-signkit-sealed-sha256': reference.sealedSha256,
			'x-signkit-signer-certificate-sha256': reference.signerCertificateSha256,
			'x-signkit-source-byte-size': String(reference.sourceByteSize),
			'x-signkit-source-sha256': reference.sourceSha256,
			'x-signkit-validation-id': reference.validationId,
			'x-signkit-validation-policy-id': reference.validationPolicyId
		});
		if (reference.tsaPolicyId !== null) {
			headers.set('x-signkit-tsa-policy-id', reference.tsaPolicyId);
			headers.set('x-signkit-tsa-trust-bundle-sha256', reference.tsaTrustBundleSha256!);
		}
		return headers;
	}

	async #performFetch(
		url: string,
		init: RequestInit,
		bodyFailure: () => PdfSealValidatorError | null,
		timeoutSignal: AbortSignal
	): Promise<Response> {
		try {
			return await this.#fetch(url, init);
		} catch (error: unknown) {
			const framingFailure: PdfSealValidatorError | null = bodyFailure();
			if (framingFailure !== null) throw framingFailure;
			if (error instanceof PdfSealValidatorError) throw error;
			const cause: unknown = errorCause(error);
			if (cause instanceof PdfSealValidatorError) throw cause;
			throw validatorError(
				timeoutSignal.aborted || isTimeoutError(error) ? 'request_timeout' : 'network_error',
				true
			);
		}
	}

	async #readValidationResponse(
		response: Response,
		reference: PdfSealValidationReference,
		timeoutSignal: AbortSignal
	): Promise<PdfSealValidationResult> {
		await assertSuccessfulResponse(response);
		if (mediaType(response.headers.get('content-type')) !== 'application/json') {
			await discardBoundedBody(response.body, MAX_VALIDATOR_ERROR_BYTES);
			throw validatorError('invalid_response', false);
		}
		const contentEncoding: string | null = response.headers.get('content-encoding');
		if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
			await discardBoundedBody(response.body, MAX_VALIDATOR_ERROR_BYTES);
			throw validatorError('invalid_response', false);
		}
		const body: Uint8Array<ArrayBuffer> = await readBoundedBody(
			response.body,
			response.headers.get('content-length'),
			MAX_VALIDATOR_JSON_BYTES,
			timeoutSignal
		);
		let envelope: ValidationEnvelope;
		try {
			const decoded: string = new TextDecoder('utf-8', { fatal: true }).decode(body);
			const parsed: unknown = JSON.parse(decoded);
			if (!isRecord(parsed)) throw new Error('not an object');
			envelope = parsed;
		} catch {
			throw validatorError('invalid_response', false);
		}
		return parseValidationEnvelope(envelope, reference);
	}
}

function normalizeBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw validatorError('invalid_configuration', false);
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.hostname.length === 0
	) {
		throw validatorError('invalid_configuration', false);
	}
	url.pathname = url.pathname.replace(/\/+$/, '') || '/';
	return url.toString().replace(/\/$/, '');
}

function validateBearerToken(value: string): string {
	if (
		typeof value !== 'string' ||
		value.length < 1 ||
		value.length > 4096 ||
		!BEARER_TOKEN_PATTERN.test(value)
	) {
		throw validatorError('invalid_configuration', false);
	}
	return value;
}

function assertReference(reference: PdfSealValidationReference, maxSealedBytes: number): void {
	assertSafeIdentifier(reference.validationId);
	assertSafeIdentifier(reference.operationId);
	assertSha256(reference.sourceSha256);
	validateIntegerRange(
		reference.sourceByteSize,
		1,
		MAX_PUBLISHED_COMPLETION_PDF_BYTES,
		'invalid_request'
	);
	assertSha256(reference.sealedSha256);
	validateIntegerRange(reference.sealedByteSize, 1, maxSealedBytes, 'invalid_request');
	if (reference.sealedByteSize <= reference.sourceByteSize) {
		throw validatorError('invalid_request', false);
	}
	assertProfile(reference.requestedProfile);
	assertSha256(reference.signerCertificateSha256);
	assertSafeIdentifier(reference.sealPolicyId);
	assertSafeIdentifier(reference.validationPolicyId);
	if (reference.requestedProfile === 'pades-b-t') {
		if (reference.tsaPolicyId === null || reference.tsaTrustBundleSha256 === null) {
			throw validatorError('invalid_request', false);
		}
		assertSafeIdentifier(reference.tsaPolicyId);
		assertSha256(reference.tsaTrustBundleSha256);
	} else if (reference.tsaPolicyId !== null || reference.tsaTrustBundleSha256 !== null) {
		throw validatorError('invalid_request', false);
	}
}

function normalizedReference(
	reference: PdfSealValidationReference,
	maxSealedBytes: number
): PdfSealValidationReference {
	assertReference(reference, maxSealedBytes);
	return {
		validationId: reference.validationId,
		operationId: reference.operationId,
		sourceSha256: reference.sourceSha256,
		sourceByteSize: reference.sourceByteSize,
		sealedSha256: reference.sealedSha256,
		sealedByteSize: reference.sealedByteSize,
		requestedProfile: reference.requestedProfile,
		signerCertificateSha256: reference.signerCertificateSha256,
		sealPolicyId: reference.sealPolicyId,
		validationPolicyId: reference.validationPolicyId,
		tsaPolicyId: reference.tsaPolicyId,
		tsaTrustBundleSha256: reference.tsaTrustBundleSha256
	};
}

function parseValidationEnvelope(
	envelope: ValidationEnvelope,
	reference: PdfSealValidationReference
): PdfSealValidationResult {
	assertEcho(envelope, reference);
	const validatorReceiptId: string = requireSafeIdentifier(envelope.validatorReceiptId);
	if (envelope.status === 'invalid') {
		return {
			...reference,
			status: 'invalid',
			validatorReceiptId,
			failureCodes: parseFailureCodes(envelope.failureCodes)
		};
	}
	if (envelope.status !== 'valid') throw validatorError('invalid_response', false);
	assertProfileResponse(envelope.achievedProfile);
	if (envelope.achievedProfile !== reference.requestedProfile) {
		throw validatorError('integrity_mismatch', false);
	}
	return {
		...reference,
		status: 'valid',
		validatorReceiptId,
		achievedProfile: envelope.achievedProfile,
		checks: parseChecks(envelope.checks, reference.requestedProfile)
	};
}

function assertEcho(envelope: ValidationEnvelope, reference: PdfSealValidationReference): void {
	if (
		envelope.validationId !== reference.validationId ||
		envelope.operationId !== reference.operationId ||
		envelope.sourceSha256 !== reference.sourceSha256 ||
		envelope.sourceByteSize !== reference.sourceByteSize ||
		envelope.sealedSha256 !== reference.sealedSha256 ||
		envelope.sealedByteSize !== reference.sealedByteSize ||
		envelope.requestedProfile !== reference.requestedProfile ||
		envelope.signerCertificateSha256 !== reference.signerCertificateSha256 ||
		envelope.sealPolicyId !== reference.sealPolicyId ||
		envelope.validationPolicyId !== reference.validationPolicyId ||
		envelope.tsaPolicyId !== reference.tsaPolicyId ||
		envelope.tsaTrustBundleSha256 !== reference.tsaTrustBundleSha256
	) {
		throw validatorError('integrity_mismatch', false);
	}
}

function parseFailureCodes(value: unknown): readonly PdfSealValidationFailureCode[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
		throw validatorError('invalid_response', false);
	}
	const codes: PdfSealValidationFailureCode[] = [];
	const seen: Set<string> = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string' || !FAILURE_CODES.has(item) || seen.has(item)) {
			throw validatorError('invalid_response', false);
		}
		seen.add(item);
		codes.push(item as PdfSealValidationFailureCode);
	}
	return codes;
}

function parseChecks(value: unknown, profile: PdfSealProfile): PdfSealValidationChecks {
	if (!isPlainRecord(value)) throw validatorError('invalid_response', false);
	const expectedTrue: readonly string[] = [
		'sourcePrefixExact',
		'incrementalUpdateValid',
		'byteRangeComplete',
		'cmsSignatureValid',
		'signerCertificateProtected',
		'signerCertificateDigestMatches',
		'certificatePathValid',
		'sealPolicyValid',
		'invisibleApprovalSignature',
		'docMdpAbsent',
		'noPostSealChanges'
	];
	for (const key of expectedTrue) {
		if (value[key] !== true) throw validatorError('integrity_mismatch', false);
	}
	if (value.cmsSubFilter !== 'ETSI.CAdES.detached') {
		throw validatorError('integrity_mismatch', false);
	}
	let timestamp: PdfSealTimestampChecks | null;
	if (profile === 'pades-b-b') {
		if (value.timestamp !== null) throw validatorError('integrity_mismatch', false);
		timestamp = null;
	} else {
		timestamp = parseTimestampChecks(value.timestamp);
	}
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

function parseTimestampChecks(value: unknown): PdfSealTimestampChecks {
	if (!isPlainRecord(value)) throw validatorError('integrity_mismatch', false);
	const keys: readonly (keyof PdfSealTimestampChecks)[] = [
		'responseStatusGranted',
		'messageImprintValid',
		'nonceValidWhenPresent',
		'policyValid',
		'tokenSignatureValid',
		'certificatePathValid',
		'ekuCriticalTimeStampingOnly',
		'essCertificateBindingValid',
		'genTimeValid'
	];
	for (const key of keys) {
		if (value[key] !== true) throw validatorError('integrity_mismatch', false);
	}
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

function framedValidationStream(
	source: ReadableStream<Uint8Array>,
	sealed: ReadableStream<Uint8Array>,
	expectedSourceSize: number,
	expectedSealedSize: number,
	timeoutSignal: AbortSignal
): FramedValidationBody {
	let sourceReader: ReadableStreamDefaultReader<Uint8Array>;
	let sealedReader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		sourceReader = source.getReader();
		sealedReader = sealed.getReader();
	} catch {
		try {
			sourceReader!.releaseLock();
		} catch {
			// The caller cancels any stream that can still be cancelled.
		}
		throw validatorError('invalid_request', false);
	}
	let phase: 'source' | 'sealed' = 'source';
	let sourceSeen: number = 0;
	let sealedSeen: number = 0;
	let framingFailure: PdfSealValidatorError | null = null;
	let resolveCompletion: (() => void) | null = null;
	let rejectCompletion: ((error: PdfSealValidatorError) => void) | null = null;
	let completionSettled: boolean = false;
	const completed: Promise<void> = new Promise<void>(
		(resolve: () => void, reject: (error: PdfSealValidatorError) => void): void => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		}
	);
	// Fetch may reject before validate reaches the explicit completion await.
	void completed.catch((): void => undefined);
	const recordFailure = (error: PdfSealValidatorError): PdfSealValidatorError => {
		if (framingFailure === null) framingFailure = error;
		if (!completionSettled) {
			completionSettled = true;
			rejectCompletion!(framingFailure);
		}
		return framingFailure;
	};
	const fail = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		error: PdfSealValidatorError
	): void => {
		controller.error(recordFailure(error));
	};
	const cancelBoth = async (error: PdfSealValidatorError): Promise<void> => {
		recordFailure(error);
		await Promise.all([
			cancelReader(sourceReader, error.code),
			cancelReader(sealedReader, error.code)
		]);
	};
	const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
		async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
			try {
				if (phase === 'source') {
					const result: ReadableStreamReadResult<Uint8Array> = await sourceReader.read();
					if (!result.done) {
						sourceSeen += result.value.byteLength;
						if (sourceSeen > expectedSourceSize) {
							const error: PdfSealValidatorError = validatorError('source_size_mismatch', false);
							await cancelBoth(error);
							fail(controller, error);
							return;
						}
						controller.enqueue(result.value);
						return;
					}
					if (sourceSeen !== expectedSourceSize) {
						const error: PdfSealValidatorError = validatorError('source_size_mismatch', false);
						await cancelBoth(error);
						fail(controller, error);
						return;
					}
					releaseReader(sourceReader);
					phase = 'sealed';
				}
				const result: ReadableStreamReadResult<Uint8Array> = await sealedReader.read();
				if (result.done) {
					if (sealedSeen !== expectedSealedSize) {
						const error: PdfSealValidatorError = validatorError('sealed_size_mismatch', false);
						await cancelBoth(error);
						fail(controller, error);
						return;
					}
					releaseReader(sealedReader);
					controller.close();
					if (!completionSettled) {
						completionSettled = true;
						resolveCompletion!();
					}
					return;
				}
				sealedSeen += result.value.byteLength;
				if (sealedSeen > expectedSealedSize) {
					const error: PdfSealValidatorError = validatorError('sealed_size_mismatch', false);
					await cancelBoth(error);
					fail(controller, error);
					return;
				}
				controller.enqueue(result.value);
			} catch (error: unknown) {
				const classified: PdfSealValidatorError = validatorError(
					timeoutSignal.aborted || isTimeoutError(error) ? 'request_timeout' : 'network_error',
					true
				);
				await cancelBoth(classified);
				fail(controller, classified);
			}
		},
		async cancel(reason: unknown): Promise<void> {
			const classified: PdfSealValidatorError =
				reason instanceof PdfSealValidatorError
					? reason
					: validatorError(timeoutSignal.aborted ? 'request_timeout' : 'network_error', true);
			await cancelBoth(classified);
		}
	});
	return {
		stream,
		completed,
		failure: (): PdfSealValidatorError | null => framingFailure,
		cancel: cancelBoth
	};
}

async function waitForFrameCompletion(
	body: FramedValidationBody,
	timeoutSignal: AbortSignal
): Promise<void> {
	if (timeoutSignal.aborted) throw validatorError('request_timeout', true);
	await new Promise<void>(
		(resolve: () => void, reject: (error: PdfSealValidatorError) => void): void => {
			const onAbort = (): void => {
				cleanup();
				reject(validatorError('request_timeout', true));
			};
			const cleanup = (): void => timeoutSignal.removeEventListener('abort', onAbort);
			timeoutSignal.addEventListener('abort', onAbort, { once: true });
			if (timeoutSignal.aborted) onAbort();
			body.completed.then(
				(): void => {
					cleanup();
					resolve();
				},
				(error: unknown): void => {
					cleanup();
					reject(classifyTransportError(error, timeoutSignal));
				}
			);
		}
	);
}

function classifyTransportError(error: unknown, timeoutSignal: AbortSignal): PdfSealValidatorError {
	if (error instanceof PdfSealValidatorError) return error;
	const cause: unknown = errorCause(error);
	if (cause instanceof PdfSealValidatorError) return cause;
	return validatorError(
		timeoutSignal.aborted || isTimeoutError(error) ? 'request_timeout' : 'network_error',
		true
	);
}

function cancelBodyBestEffort(body: ReadableStream<Uint8Array> | null, reason: string): void {
	if (body === null) return;
	void body.cancel(reason).catch((): void => undefined);
}

async function cancelReadableStream(value: unknown, reason: string): Promise<void> {
	if (!isReadableByteStream(value) || value.locked) return;
	try {
		await value.cancel(reason);
	} catch {
		// Pre-flight rejection remains authoritative.
	}
}

async function cancelReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	reason: unknown
): Promise<void> {
	try {
		await reader.cancel(reason);
	} catch {
		// The original size or transport failure remains authoritative.
	} finally {
		releaseReader(reader);
	}
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		reader.releaseLock();
	} catch {
		// Release is best effort after completion or cancellation.
	}
}

async function assertSuccessfulResponse(response: Response): Promise<void> {
	const redirectFailure: PdfSealValidatorError | null = responseRedirectFailure(response);
	if (redirectFailure !== null) {
		await cancelBody(response.body, redirectFailure.code);
		throw redirectFailure;
	}
	if (response.status >= 200 && response.status < 300) return;
	await discardBoundedBody(response.body, MAX_VALIDATOR_ERROR_BYTES);
	if (response.status === 408) {
		throw validatorError('request_timeout', true, response.status);
	}
	if (response.status === 425 || response.status === 429) {
		throw validatorError('rate_limited', true, response.status);
	}
	if (response.status >= 500) {
		throw validatorError('validator_unavailable', true, response.status);
	}
	if (response.status === 401 || response.status === 403) {
		throw validatorError('validator_authentication_failed', false, response.status);
	}
	if (response.status === 409) {
		throw validatorError('validation_conflict', false, response.status);
	}
	throw validatorError('validator_rejected', false, response.status);
}

function responseRedirectFailure(response: Response): PdfSealValidatorError | null {
	if (
		response.redirected ||
		response.type === 'opaqueredirect' ||
		(response.status >= 300 && response.status < 400)
	) {
		return validatorError('validator_redirected', false, response.status);
	}
	return null;
}

async function readBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	contentLength: string | null,
	maxBytes: number,
	timeoutSignal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
	if (body === null) throw validatorError('invalid_response', false);
	let declaredLength: number | null;
	try {
		declaredLength = parseOptionalLength(contentLength);
	} catch (error: unknown) {
		await discardBoundedBody(body, MAX_VALIDATOR_ERROR_BYTES);
		if (error instanceof PdfSealValidatorError) throw error;
		throw validatorError('invalid_response', false);
	}
	if (declaredLength !== null && declaredLength > maxBytes) {
		await discardBoundedBody(body, MAX_VALIDATOR_ERROR_BYTES);
		throw validatorError('response_too_large', false);
	}
	const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
	const chunks: Uint8Array[] = [];
	let total: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await readWithTimeout(
				reader,
				timeoutSignal
			);
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) {
				await cancelReader(reader, 'response_too_large');
				throw validatorError('response_too_large', false);
			}
			chunks.push(result.value);
		}
	} catch (error: unknown) {
		if (error instanceof PdfSealValidatorError) throw error;
		throw validatorError(
			timeoutSignal.aborted || isTimeoutError(error) ? 'request_timeout' : 'network_error',
			true
		);
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore lock release failure.
		}
	}
	if (declaredLength !== null && declaredLength !== total) {
		throw validatorError('invalid_response', false);
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(total));
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutSignal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (timeoutSignal.aborted) throw validatorError('request_timeout', true);
	return new Promise<ReadableStreamReadResult<Uint8Array>>(
		(
			resolve: (result: ReadableStreamReadResult<Uint8Array>) => void,
			reject: (error: PdfSealValidatorError) => void
		): void => {
			const onAbort = (): void => {
				cleanup();
				void reader.cancel('request_timeout').catch((): void => undefined);
				reject(validatorError('request_timeout', true));
			};
			const cleanup = (): void => timeoutSignal.removeEventListener('abort', onAbort);
			timeoutSignal.addEventListener('abort', onAbort, { once: true });
			if (timeoutSignal.aborted) onAbort();
			reader.read().then(
				(result: ReadableStreamReadResult<Uint8Array>): void => {
					cleanup();
					resolve(result);
				},
				(): void => {
					cleanup();
					reject(validatorError(timeoutSignal.aborted ? 'request_timeout' : 'network_error', true));
				}
			);
		}
	);
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
		await cancelReader(reader, 'error_body_limit_reached');
	} catch {
		// The HTTP status remains authoritative.
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore lock release failure.
		}
	}
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, reason: string): Promise<void> {
	if (body === null) return;
	try {
		await body.cancel(reason);
	} catch {
		// Redirect classification remains authoritative.
	}
}

function parseOptionalLength(value: string | null): number | null {
	if (value === null) return null;
	if (!/^(0|[1-9][0-9]*)$/.test(value)) throw validatorError('invalid_response', false);
	const parsed: number = Number(value);
	if (!Number.isSafeInteger(parsed)) throw validatorError('invalid_response', false);
	return parsed;
}

function mediaType(value: string | null): string | null {
	if (value === null) return null;
	return value.split(';', 1)[0]?.trim().toLowerCase() ?? null;
}

function isRecord(value: unknown): value is ValidationEnvelope {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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
		typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError'
	);
}

function assertProfile(value: unknown): asserts value is PdfSealProfile {
	if (value !== 'pades-b-b' && value !== 'pades-b-t') {
		throw validatorError('invalid_request', false);
	}
}

function assertProfileResponse(value: unknown): asserts value is PdfSealProfile {
	if (value !== 'pades-b-b' && value !== 'pades-b-t') {
		throw validatorError('invalid_response', false);
	}
}

function assertSha256(value: string): void {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
		throw validatorError('invalid_request', false);
	}
}

function assertSafeIdentifier(value: string): void {
	if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
		throw validatorError('invalid_request', false);
	}
}

function requireSafeIdentifier(value: unknown): string {
	if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
		throw validatorError('invalid_response', false);
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
		throw validatorError(code, false);
	}
	return value;
}

function validatorError(
	code: PdfSealValidatorError['code'],
	retryable: boolean,
	httpStatus: number | null = null
): PdfSealValidatorError {
	return new PdfSealValidatorError(code, retryable, httpStatus);
}
