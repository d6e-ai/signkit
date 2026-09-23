import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import {
	ExactObjectStreamError,
	readExactObjectStream,
	verifyImmutableObject,
	type ImmutableObjectVerification
} from '$lib/application/completion-artifacts/exact-object-stream';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import { newOpaqueToken, type OpaqueTokenGenerator } from '$lib/security/opaque-token';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import {
	boundPdfSealClaimLimit,
	assertPdfSealErrorCode,
	MAX_PDF_SEAL_VALIDATION_REPORT_BYTES,
	PDF_SEAL_JOB_MAX_CLAIM_BATCH,
	assertValidPdfSealArtifact,
	assertValidPdfSealValidationEvidence,
	type ClaimedPdfSealJob,
	type PdfSealJob,
	type PdfSealJobStore,
	type PdfSealSealedArtifact,
	type PdfSealValidationEvidence
} from '$lib/ports/pdf-seal-job-store';
import {
	PdfSealProviderError,
	type PdfSealOperationReceipt,
	type PdfSealOperationReference,
	type PdfSealProfile,
	type PdfSealProvider,
	type PdfSealProviderOperation,
	type PdfSealResult,
	type PdfSealSucceededOperation
} from '$lib/ports/pdf-seal-provider';
import {
	PdfSealValidatorError,
	type PdfSealValidationChecks,
	type PdfSealValidationResult,
	type PdfSealTimestampChecks,
	type PdfSealValidator,
	type ValidatePdfSealCommand
} from '$lib/ports/pdf-seal-validator';

/** Bounded processing lease; a crashed worker's claim becomes reclaimable after this. */
export const PDF_SEAL_CLAIM_LEASE_MS: number = 5 * 60 * 1000;

const GENERIC_RETRYABLE_ERROR_CODE: string = 'pdf_seal_transient_failure';
const SOURCE_MISSING_ERROR_CODE: string = 'pdf_seal_source_object_missing';
const SOURCE_MISMATCHED_ERROR_CODE: string = 'pdf_seal_source_object_mismatched';
const SEALED_MISSING_ERROR_CODE: string = 'pdf_seal_sealed_object_missing';
const SEALED_MISMATCHED_ERROR_CODE: string = 'pdf_seal_sealed_object_mismatched';
const RESULT_MISMATCHED_ERROR_CODE: string = 'pdf_seal_provider_result_mismatched';
const OPERATION_MISMATCHED_ERROR_CODE: string = 'pdf_seal_provider_operation_mismatched';
const VALIDATION_MISMATCHED_ERROR_CODE: string = 'pdf_seal_validation_result_mismatched';
const MISSING_RECEIPT_ERROR_CODE: string = 'pdf_seal_missing_provider_receipt';
const MISSING_SEALED_ARTIFACT_ERROR_CODE: string = 'pdf_seal_missing_sealed_artifact';
const ACHIEVED_PROFILE_MISMATCH_ERROR_CODE: string = 'pdf_seal_achieved_profile_mismatched';
const SEALED_WRITE_CONFLICT_ERROR_CODE: string = 'pdf_seal_sealed_write_conflict';
const REPORT_WRITE_CONFLICT_ERROR_CODE: string = 'pdf_seal_report_write_conflict';
const REPORT_TOO_LARGE_ERROR_CODE: string = 'pdf_seal_report_too_large';
const INVALID_VALIDATION_FALLBACK_ERROR_CODE: string = 'pdf_seal_validation_invalid';
const INVALID_REMOTE_ERROR_CODE: string = 'pdf_seal_invalid_remote_error';

const SEALED_PDF_CONTENT_TYPE: string = 'application/pdf';
const VALIDATION_REPORT_CONTENT_TYPE: string =
	'application/vnd.signkit.pdf-seal-validation-report+json';
const OBJECT_FORMAT_METADATA: Readonly<Record<string, string>> = { format: 'signkit-pdf-seal-v1' };

export type PdfSealBatchItemOutcome =
	| {
			jobId: string;
			outcome:
				| 'submitted'
				| 'ambiguous_submit'
				| 'provider_pending'
				| 'sealed'
				| 'publication_ready'
				| 'stale';
	  }
	| { jobId: string; outcome: 'retryable_failed' | 'permanently_failed'; errorCode: string };

export interface PdfSealBatchResult {
	claimed: number;
	outcomes: readonly PdfSealBatchItemOutcome[];
}

interface PdfSealAttemptFields {
	jobId: string;
	claimToken: string;
	attemptId: string;
	attemptNumber: number;
	startedAt: string;
	finishedAt: string;
}

class PdfSealIntegrityError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'PdfSealIntegrityError';
	}
}

interface PdfSealValidationReport {
	jobId: string;
	envelopeId: string;
	operationId: string;
	validationId: string;
	requestedProfile: PdfSealProfile;
	achievedProfile: PdfSealProfile;
	validatorReceiptId: string;
	sourceObjectKey: string;
	sourceSha256: string;
	sourceByteSize: number;
	sealedObjectKey: string;
	sealedSha256: string;
	sealedByteSize: number;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
	checks: PdfSealValidationChecks;
}

/**
 * Runtime-neutral pre-publication orchestrator for durable PDF seal jobs.
 *
 * Advances jobs claimed from {@link PdfSealJobStore} through `submit` /
 * `recover_submit` / `poll_provider` / `validate` up to `publication_ready`.
 * It never publishes: the protected drain owns the separate atomic publish
 * action after this service reaches `publication_ready`.
 */
export class PdfSealService {
	readonly #store: PdfSealJobStore;
	readonly #objects: ObjectStore;
	readonly #provider: PdfSealProvider;
	readonly #validator: PdfSealValidator;
	readonly #now: () => Date;
	readonly #newClaimToken: OpaqueTokenGenerator;
	readonly #newAttemptId: UuidV7Generator;

	constructor(
		store: PdfSealJobStore,
		objects: ObjectStore,
		provider: PdfSealProvider,
		validator: PdfSealValidator,
		now: () => Date = (): Date => new Date(),
		newClaimToken: OpaqueTokenGenerator = newOpaqueToken,
		newAttemptId: UuidV7Generator = newUuidV7
	) {
		this.#store = store;
		this.#objects = objects;
		this.#provider = provider;
		this.#validator = validator;
		this.#now = now;
		this.#newClaimToken = newClaimToken;
		this.#newAttemptId = newAttemptId;
	}

	/**
	 * Claims a bounded batch of eligible jobs and advances each one exactly
	 * once, strictly sequentially (concurrency one). One item's failure never
	 * prevents the remaining items in the batch from being attempted.
	 */
	async processPendingBatch(
		limit: number = PDF_SEAL_JOB_MAX_CLAIM_BATCH
	): Promise<PdfSealBatchResult> {
		const claimedAt: Date = this.#now();
		const claims: readonly ClaimedPdfSealJob[] = await this.#store.claim({
			claimToken: this.#newClaimToken(),
			claimedAt: claimedAt.toISOString(),
			staleBefore: new Date(claimedAt.valueOf() - PDF_SEAL_CLAIM_LEASE_MS).toISOString(),
			limit: boundPdfSealClaimLimit(limit)
		});
		const outcomes: PdfSealBatchItemOutcome[] = [];
		for (const claim of claims) {
			outcomes.push(await this.#processClaimIsolated(claim));
		}
		return { claimed: claims.length, outcomes };
	}

	/** Claims and advances exactly one job, or returns `null` if it was not eligible. */
	async processJob(jobId: string): Promise<PdfSealBatchItemOutcome | null> {
		const claimedAt: Date = this.#now();
		const claims: readonly ClaimedPdfSealJob[] = await this.#store.claim({
			claimToken: this.#newClaimToken(),
			claimedAt: claimedAt.toISOString(),
			staleBefore: new Date(claimedAt.valueOf() - PDF_SEAL_CLAIM_LEASE_MS).toISOString(),
			limit: 1,
			jobId
		});
		const claim: ClaimedPdfSealJob | undefined = claims[0];
		if (claim === undefined) return null;
		return this.#processClaimIsolated(claim);
	}

	async #processClaimIsolated(claimed: ClaimedPdfSealJob): Promise<PdfSealBatchItemOutcome> {
		try {
			return await this.#processClaim(claimed);
		} catch {
			// A storage or transport fault escaped every typed catch below (a bug,
			// or the job store itself failing mid-transition). This item is
			// isolated from the rest of the batch; the lease expires and a later
			// claim retries it, exactly as an ordinary retryable failure would.
			return {
				jobId: claimed.job.jobId,
				outcome: 'retryable_failed',
				errorCode: GENERIC_RETRYABLE_ERROR_CODE
			};
		}
	}

	async #processClaim(claimed: ClaimedPdfSealJob): Promise<PdfSealBatchItemOutcome> {
		switch (claimed.job.nextAction) {
			case 'submit':
				return this.#submit(claimed, false);
			case 'recover_submit':
				return this.#submit(claimed, true);
			case 'poll_provider':
				return this.#poll(claimed);
			case 'validate':
				return this.#validate(claimed);
			case 'publish':
				// The store never claims a job whose next action is 'publish'.
				return { jobId: claimed.job.jobId, outcome: 'stale' };
		}
	}

	async #submit(claimed: ClaimedPdfSealJob, isRecover: boolean): Promise<PdfSealBatchItemOutcome> {
		const job: PdfSealJob = claimed.job;
		const now: Date = this.#now();
		const reference: PdfSealOperationReference = {
			operationId: job.operationId,
			sourceSha256: job.sourceSha256,
			sourceByteSize: job.sourceByteSize,
			requestedProfile: job.requestedProfile,
			signerCertificateSha256: job.signerCertificateSha256,
			sealPolicyId: job.sealPolicyId,
			validationPolicyId: job.validationPolicyId,
			tsaPolicyId: job.tsaPolicyId,
			tsaTrustBundleSha256: job.tsaTrustBundleSha256
		};

		let operation: PdfSealProviderOperation;
		let submittedSource: ReadableStream<Uint8Array> | null = null;
		try {
			if (isRecover) {
				operation = await this.#provider.recoverAmbiguousSubmit(reference);
			} else {
				let source: ReadableStream<Uint8Array>;
				try {
					source = await verifyAndOpenFreshStream(
						this.#objects,
						job.sourceObjectKey,
						job.sourceSha256,
						job.sourceByteSize,
						SOURCE_MISSING_ERROR_CODE,
						SOURCE_MISMATCHED_ERROR_CODE
					);
				} catch (error: unknown) {
					return this.#failFromIntegrityOrGeneric(claimed, error, now);
				}
				submittedSource = source;
				operation = await this.#provider.submit({ ...reference, source });
			}
		} catch (error: unknown) {
			if (submittedSource !== null) await cancelStreamQuietly(submittedSource);
			if (error instanceof PdfSealProviderError) {
				if (error.ambiguous && !isRecover) {
					const ok: boolean = await this.#store.checkpoint({
						kind: 'ambiguous_submit',
						...this.#attemptFields(claimed, now)
					});
					return ok
						? { jobId: job.jobId, outcome: 'ambiguous_submit' }
						: { jobId: job.jobId, outcome: 'stale' };
				}
				return this.#fail(claimed, error.code, error.retryable, now);
			}
			return this.#fail(claimed, GENERIC_RETRYABLE_ERROR_CODE, true, now);
		}

		// Any receipt — regardless of the operation's own status — is durably
		// checkpointed first; a later claim polls it. Acting on the status here
		// would let a crash between this checkpoint and that action lose the
		// only record that the provider ever accepted the operation.
		if (!operationMatchesReference(operation, reference)) {
			return this.#fail(claimed, OPERATION_MISMATCHED_ERROR_CODE, false, now);
		}
		const ok: boolean = await this.#store.checkpoint({
			kind: 'provider_receipt',
			providerReceiptId: operation.providerReceiptId,
			...this.#attemptFields(claimed, now)
		});
		return ok ? { jobId: job.jobId, outcome: 'submitted' } : { jobId: job.jobId, outcome: 'stale' };
	}

	async #poll(claimed: ClaimedPdfSealJob): Promise<PdfSealBatchItemOutcome> {
		const job: PdfSealJob = claimed.job;
		const now: Date = this.#now();
		if (job.providerReceiptId === null) {
			return this.#fail(claimed, MISSING_RECEIPT_ERROR_CODE, false, now);
		}
		const receipt: PdfSealOperationReceipt = {
			operationId: job.operationId,
			providerReceiptId: job.providerReceiptId,
			sourceSha256: job.sourceSha256,
			sourceByteSize: job.sourceByteSize,
			requestedProfile: job.requestedProfile,
			signerCertificateSha256: job.signerCertificateSha256,
			sealPolicyId: job.sealPolicyId,
			validationPolicyId: job.validationPolicyId,
			tsaPolicyId: job.tsaPolicyId,
			tsaTrustBundleSha256: job.tsaTrustBundleSha256
		};

		let operation: PdfSealProviderOperation;
		try {
			operation = await this.#provider.getStatus(receipt);
		} catch (error: unknown) {
			if (error instanceof PdfSealProviderError) {
				return this.#fail(claimed, error.code, error.retryable, now);
			}
			return this.#fail(claimed, GENERIC_RETRYABLE_ERROR_CODE, true, now);
		}
		if (!operationMatchesReference(operation, receipt)) {
			return this.#fail(claimed, OPERATION_MISMATCHED_ERROR_CODE, false, now);
		}

		if (operation.status === 'succeeded') {
			return this.#handleSucceededOperation(claimed, operation, now);
		}
		if (operation.status === 'pending' || operation.status === 'processing') {
			const ok: boolean = await this.#store.checkpoint({
				kind: 'provider_pending',
				providerReceiptId: operation.providerReceiptId,
				...this.#attemptFields(claimed, now)
			});
			return ok
				? { jobId: job.jobId, outcome: 'provider_pending' }
				: { jobId: job.jobId, outcome: 'stale' };
		}
		if (operation.status === 'failed') {
			// The receipt is already durably checkpointed (this action is only
			// reachable after that), so failing the job here is a well-defined
			// transition, not one invented ahead of its evidence.
			return this.#fail(claimed, operation.errorCode, operation.retryable, now);
		}
		return this.#fail(claimed, OPERATION_MISMATCHED_ERROR_CODE, false, now);
	}

	async #handleSucceededOperation(
		claimed: ClaimedPdfSealJob,
		operation: PdfSealSucceededOperation,
		now: Date
	): Promise<PdfSealBatchItemOutcome> {
		const job: PdfSealJob = claimed.job;
		let result: PdfSealResult;
		try {
			result = await this.#provider.readResult(operation);
		} catch (error: unknown) {
			if (error instanceof PdfSealProviderError) {
				return this.#fail(claimed, error.code, error.retryable, now);
			}
			return this.#fail(claimed, GENERIC_RETRYABLE_ERROR_CODE, true, now);
		}

		if (
			result.providerReceiptId !== operation.providerReceiptId ||
			result.sha256 !== operation.resultSha256 ||
			result.byteSize !== operation.resultByteSize ||
			result.bytes.byteLength !== result.byteSize ||
			result.achievedProfile !== operation.achievedProfile ||
			(await sha256Hex(result.bytes)) !== result.sha256
		) {
			return this.#fail(claimed, RESULT_MISMATCHED_ERROR_CODE, false, now);
		}
		if (result.achievedProfile !== job.requestedProfile) {
			return this.#fail(claimed, ACHIEVED_PROFILE_MISMATCH_ERROR_CODE, false, now);
		}

		const sealedKey: string = pdfSealSealedObjectKey(job.envelopeId, result.sha256);
		const sealedArtifact: PdfSealSealedArtifact = {
			objectKey: sealedKey,
			sha256: result.sha256,
			byteSize: result.byteSize,
			achievedProfile: result.achievedProfile
		};
		try {
			assertValidPdfSealArtifact(sealedArtifact, job.sourceByteSize, job.requestedProfile);
		} catch {
			return this.#fail(claimed, RESULT_MISMATCHED_ERROR_CODE, false, now);
		}
		try {
			await this.#persistImmutable(
				sealedKey,
				result.bytes,
				result.sha256,
				SEALED_PDF_CONTENT_TYPE,
				SEALED_WRITE_CONFLICT_ERROR_CODE
			);
		} catch (error: unknown) {
			return this.#failFromIntegrityOrGeneric(claimed, error, now);
		}

		const ok: boolean = await this.#store.checkpoint({
			kind: 'provider_result',
			providerReceiptId: result.providerReceiptId,
			sealedArtifact,
			...this.#attemptFields(claimed, now)
		});
		return ok ? { jobId: job.jobId, outcome: 'sealed' } : { jobId: job.jobId, outcome: 'stale' };
	}

	async #validate(claimed: ClaimedPdfSealJob): Promise<PdfSealBatchItemOutcome> {
		const job: PdfSealJob = claimed.job;
		const now: Date = this.#now();
		if (job.providerReceiptId === null) {
			return this.#fail(claimed, MISSING_RECEIPT_ERROR_CODE, false, now);
		}
		if (job.sealedArtifact === null) {
			return this.#fail(claimed, MISSING_SEALED_ARTIFACT_ERROR_CODE, false, now);
		}
		const sealedArtifact: PdfSealSealedArtifact = job.sealedArtifact;

		let source: ReadableStream<Uint8Array>;
		let sealed: ReadableStream<Uint8Array>;
		try {
			source = await verifyAndOpenFreshStream(
				this.#objects,
				job.sourceObjectKey,
				job.sourceSha256,
				job.sourceByteSize,
				SOURCE_MISSING_ERROR_CODE,
				SOURCE_MISMATCHED_ERROR_CODE
			);
			try {
				sealed = await verifyAndOpenFreshStream(
					this.#objects,
					sealedArtifact.objectKey,
					sealedArtifact.sha256,
					sealedArtifact.byteSize,
					SEALED_MISSING_ERROR_CODE,
					SEALED_MISMATCHED_ERROR_CODE
				);
			} catch (error: unknown) {
				await cancelStreamQuietly(source);
				throw error;
			}
		} catch (error: unknown) {
			return this.#failFromIntegrityOrGeneric(claimed, error, now);
		}

		const command: ValidatePdfSealCommand = {
			validationId: job.validationId,
			operationId: job.operationId,
			sourceSha256: job.sourceSha256,
			sourceByteSize: job.sourceByteSize,
			sealedSha256: sealedArtifact.sha256,
			sealedByteSize: sealedArtifact.byteSize,
			requestedProfile: job.requestedProfile,
			signerCertificateSha256: job.signerCertificateSha256,
			sealPolicyId: job.sealPolicyId,
			validationPolicyId: job.validationPolicyId,
			tsaPolicyId: job.tsaPolicyId,
			tsaTrustBundleSha256: job.tsaTrustBundleSha256,
			source,
			sealed
		};

		let result: PdfSealValidationResult;
		try {
			result = await this.#validator.validate(command);
		} catch (error: unknown) {
			await Promise.all([cancelStreamQuietly(source), cancelStreamQuietly(sealed)]);
			if (error instanceof PdfSealValidatorError) {
				return this.#fail(claimed, error.code, error.retryable, now);
			}
			return this.#fail(claimed, GENERIC_RETRYABLE_ERROR_CODE, true, now);
		}
		await Promise.all([cancelStreamQuietly(source), cancelStreamQuietly(sealed)]);
		if (!validationMatchesCommand(result, command)) {
			return this.#fail(claimed, VALIDATION_MISMATCHED_ERROR_CODE, false, now);
		}

		if (result.status === 'invalid') {
			const errorCode: string = result.failureCodes[0] ?? INVALID_VALIDATION_FALLBACK_ERROR_CODE;
			return this.#fail(claimed, errorCode, false, now);
		}
		if (result.achievedProfile !== job.requestedProfile) {
			return this.#fail(claimed, ACHIEVED_PROFILE_MISMATCH_ERROR_CODE, false, now);
		}

		const checks: PdfSealValidationChecks = canonicalValidationChecks(result.checks);
		const validatedAt: string = now.toISOString();
		const report: PdfSealValidationReport = {
			jobId: job.jobId,
			envelopeId: job.envelopeId,
			operationId: job.operationId,
			validationId: job.validationId,
			requestedProfile: job.requestedProfile,
			achievedProfile: result.achievedProfile,
			validatorReceiptId: result.validatorReceiptId,
			sourceObjectKey: job.sourceObjectKey,
			sourceSha256: job.sourceSha256,
			sourceByteSize: job.sourceByteSize,
			sealedObjectKey: sealedArtifact.objectKey,
			sealedSha256: sealedArtifact.sha256,
			sealedByteSize: sealedArtifact.byteSize,
			signerCertificateSha256: job.signerCertificateSha256,
			sealPolicyId: job.sealPolicyId,
			validationPolicyId: job.validationPolicyId,
			tsaPolicyId: job.tsaPolicyId,
			tsaTrustBundleSha256: job.tsaTrustBundleSha256,
			checks
		};
		const reportJson: string = canonicalPdfSealValidationReportJson(report);
		const reportBytes: Uint8Array = new TextEncoder().encode(reportJson);
		if (reportBytes.byteLength > MAX_PDF_SEAL_VALIDATION_REPORT_BYTES) {
			return this.#fail(claimed, REPORT_TOO_LARGE_ERROR_CODE, false, now);
		}
		const reportSha256: string = await sha256Hex(reportBytes);
		const reportKey: string = pdfSealValidationReportObjectKey(
			job.envelopeId,
			job.jobId,
			reportSha256
		);
		const validationEvidence: PdfSealValidationEvidence = {
			validatorReceiptId: result.validatorReceiptId,
			checks,
			reportObjectKey: reportKey,
			reportSha256,
			reportByteSize: reportBytes.byteLength,
			validatedAt
		};
		try {
			assertValidPdfSealValidationEvidence(validationEvidence, job.requestedProfile);
		} catch {
			return this.#fail(claimed, INVALID_VALIDATION_FALLBACK_ERROR_CODE, false, now);
		}
		try {
			await this.#persistImmutable(
				reportKey,
				reportBytes,
				reportSha256,
				VALIDATION_REPORT_CONTENT_TYPE,
				REPORT_WRITE_CONFLICT_ERROR_CODE
			);
		} catch (error: unknown) {
			return this.#failFromIntegrityOrGeneric(claimed, error, now);
		}
		const ok: boolean = await this.#store.complete({
			providerReceiptId: job.providerReceiptId,
			sealedArtifact,
			validationEvidence,
			...this.#attemptFields(claimed, now)
		});
		return ok
			? { jobId: job.jobId, outcome: 'publication_ready' }
			: { jobId: job.jobId, outcome: 'stale' };
	}

	async #persistImmutable(
		key: string,
		bytes: Uint8Array,
		sha256: string,
		contentType: string,
		conflictErrorCode: string
	): Promise<void> {
		let writeError: unknown = null;
		try {
			const stored: ObjectMetadata = await this.#objects.putImmutable(key, {
				contentType,
				body: bytes,
				sha256,
				metadata: OBJECT_FORMAT_METADATA
			});
			if (stored.key !== key || stored.size !== bytes.byteLength || stored.sha256 !== sha256) {
				throw new PdfSealIntegrityError(conflictErrorCode);
			}
		} catch (error: unknown) {
			writeError = error;
		}
		// A successful response is not publication evidence. Always re-open and
		// re-hash the exact immutable object; the same reconciliation also covers
		// a precondition failure or a response lost after the storage write landed.
		const outcome: ImmutableObjectVerification = await verifyImmutableObject(
			this.#objects,
			key,
			sha256,
			bytes.byteLength
		);
		if (outcome === 'verified') return;
		if (outcome === 'mismatched') {
			throw new PdfSealIntegrityError(conflictErrorCode);
		}
		if (writeError !== null) throw writeError;
		throw new Error('immutable_object_verification_unavailable');
	}

	async #fail(
		claimed: ClaimedPdfSealJob,
		errorCode: string,
		retryable: boolean,
		now: Date
	): Promise<PdfSealBatchItemOutcome> {
		const safeErrorCode: string = safePdfSealErrorCode(errorCode);
		const safeRetryable: boolean = safeErrorCode === errorCode ? retryable : false;
		const ok: boolean = await this.#store.fail({
			errorCode: safeErrorCode,
			retryable: safeRetryable,
			...this.#attemptFields(claimed, now)
		});
		if (!ok) return { jobId: claimed.job.jobId, outcome: 'stale' };
		return {
			jobId: claimed.job.jobId,
			outcome: safeRetryable ? 'retryable_failed' : 'permanently_failed',
			errorCode: safeErrorCode
		};
	}

	/** Maps a thrown integrity error to a permanent failure, anything else to the generic retryable one. */
	async #failFromIntegrityOrGeneric(
		claimed: ClaimedPdfSealJob,
		error: unknown,
		now: Date
	): Promise<PdfSealBatchItemOutcome> {
		if (error instanceof PdfSealIntegrityError) {
			return this.#fail(claimed, error.code, false, now);
		}
		return this.#fail(claimed, GENERIC_RETRYABLE_ERROR_CODE, true, now);
	}

	#attemptFields(claimed: ClaimedPdfSealJob, now: Date): PdfSealAttemptFields {
		return {
			jobId: claimed.job.jobId,
			claimToken: claimed.claimToken,
			attemptId: this.#newAttemptId(),
			attemptNumber: claimed.job.attemptSequence,
			startedAt: claimed.startedAt,
			finishedAt: now.toISOString()
		};
	}
}

/**
 * Verifies an already-attested immutable object's head metadata, fully reads
 * and rehashes its exact bytes, then opens a second, fresh stream over the
 * same key for the caller to consume. Verification and consumption never
 * share one stream.
 */
async function verifyAndOpenFreshStream(
	objects: ObjectStore,
	key: string,
	expectedSha256: string,
	expectedSize: number,
	missingErrorCode: string,
	mismatchedErrorCode: string
): Promise<ReadableStream<Uint8Array>> {
	const metadata: ObjectMetadata | null = await objects.head(key);
	if (metadata === null) throw new PdfSealIntegrityError(missingErrorCode);
	if (
		metadata.key !== key ||
		metadata.size !== expectedSize ||
		metadata.sha256 !== expectedSha256
	) {
		throw new PdfSealIntegrityError(mismatchedErrorCode);
	}
	const verifyStream: ReadableStream<Uint8Array> | null = await objects.get(key);
	if (verifyStream === null) throw new PdfSealIntegrityError(missingErrorCode);
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = await readExactObjectStream(verifyStream, expectedSize);
	} catch (error: unknown) {
		if (error instanceof ExactObjectStreamError)
			throw new PdfSealIntegrityError(mismatchedErrorCode);
		throw error;
	}
	if ((await sha256Hex(bytes)) !== expectedSha256) {
		throw new PdfSealIntegrityError(mismatchedErrorCode);
	}
	const freshStream: ReadableStream<Uint8Array> | null = await objects.get(key);
	if (freshStream === null) throw new PdfSealIntegrityError(missingErrorCode);
	return freshStream;
}

export function pdfSealSealedObjectKey(envelopeId: string, sha256: string): string {
	return `pdf-seals/v1/envelopes/${encodeScopeSegment(envelopeId)}/sealed/sha256/${sha256}.pdf`;
}

export function pdfSealValidationReportObjectKey(
	envelopeId: string,
	jobId: string,
	sha256: string
): string {
	return `pdf-seals/v1/envelopes/${encodeScopeSegment(envelopeId)}/jobs/${encodeScopeSegment(jobId)}/validation-reports/sha256/${sha256}.json`;
}

function canonicalPdfSealValidationReportJson(report: PdfSealValidationReport): string {
	return JSON.stringify(report);
}

function encodeScopeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

function operationMatchesReference(
	operation: PdfSealProviderOperation,
	reference: PdfSealOperationReference
): boolean {
	return (
		operation.operationId === reference.operationId &&
		operation.sourceSha256 === reference.sourceSha256 &&
		operation.sourceByteSize === reference.sourceByteSize &&
		operation.requestedProfile === reference.requestedProfile &&
		operation.signerCertificateSha256 === reference.signerCertificateSha256 &&
		operation.sealPolicyId === reference.sealPolicyId &&
		operation.validationPolicyId === reference.validationPolicyId &&
		operation.tsaPolicyId === reference.tsaPolicyId &&
		operation.tsaTrustBundleSha256 === reference.tsaTrustBundleSha256 &&
		(!('providerReceiptId' in reference) ||
			operation.providerReceiptId === reference.providerReceiptId)
	);
}

function validationMatchesCommand(
	result: PdfSealValidationResult,
	command: ValidatePdfSealCommand
): boolean {
	return (
		result.validationId === command.validationId &&
		result.operationId === command.operationId &&
		result.sourceSha256 === command.sourceSha256 &&
		result.sourceByteSize === command.sourceByteSize &&
		result.sealedSha256 === command.sealedSha256 &&
		result.sealedByteSize === command.sealedByteSize &&
		result.requestedProfile === command.requestedProfile &&
		result.signerCertificateSha256 === command.signerCertificateSha256 &&
		result.sealPolicyId === command.sealPolicyId &&
		result.validationPolicyId === command.validationPolicyId &&
		result.tsaPolicyId === command.tsaPolicyId &&
		result.tsaTrustBundleSha256 === command.tsaTrustBundleSha256
	);
}

function safePdfSealErrorCode(value: string): string {
	try {
		assertPdfSealErrorCode(value);
		return value;
	} catch {
		return INVALID_REMOTE_ERROR_CODE;
	}
}

function canonicalValidationChecks(checks: PdfSealValidationChecks): PdfSealValidationChecks {
	return {
		sourcePrefixExact: checks.sourcePrefixExact,
		incrementalUpdateValid: checks.incrementalUpdateValid,
		byteRangeComplete: checks.byteRangeComplete,
		cmsSignatureValid: checks.cmsSignatureValid,
		cmsSubFilter: checks.cmsSubFilter,
		signerCertificateProtected: checks.signerCertificateProtected,
		signerCertificateDigestMatches: checks.signerCertificateDigestMatches,
		certificatePathValid: checks.certificatePathValid,
		sealPolicyValid: checks.sealPolicyValid,
		invisibleApprovalSignature: checks.invisibleApprovalSignature,
		docMdpAbsent: checks.docMdpAbsent,
		noPostSealChanges: checks.noPostSealChanges,
		timestamp: checks.timestamp === null ? null : canonicalTimestampChecks(checks.timestamp)
	};
}

function canonicalTimestampChecks(checks: PdfSealTimestampChecks): PdfSealTimestampChecks {
	return {
		responseStatusGranted: checks.responseStatusGranted,
		messageImprintValid: checks.messageImprintValid,
		nonceValidWhenPresent: checks.nonceValidWhenPresent,
		policyValid: checks.policyValid,
		tokenSignatureValid: checks.tokenSignatureValid,
		certificatePathValid: checks.certificatePathValid,
		ekuCriticalTimeStampingOnly: checks.ekuCriticalTimeStampingOnly,
		essCertificateBindingValid: checks.essCertificateBindingValid,
		genTimeValid: checks.genTimeValid
	};
}

async function cancelStreamQuietly(stream: ReadableStream<Uint8Array>): Promise<void> {
	try {
		await stream.cancel('PDF seal operation finished');
	} catch {
		// A provider may already have consumed and released the stream.
	}
}
