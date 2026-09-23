import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import {
	assertPdfSealAttemptCommand,
	assertPdfSealErrorCode,
	assertPdfSealProviderReceipt,
	assertValidPdfSealArtifact,
	assertValidPdfSealFrozenReference,
	assertValidPdfSealValidationEvidence,
	boundPdfSealClaimLimit,
	pdfSealProviderPollAvailableAt,
	pdfSealRetryAvailableAt,
	PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES,
	type ClaimPdfSealJobsCommand,
	type ClaimedPdfSealJob,
	type CompletePdfSealJobCommand,
	type EnqueuePdfSealJobCommand,
	type EnqueuePdfSealJobResult,
	type FailPdfSealJobCommand,
	type PdfSealCheckpointCommand,
	type PdfSealJob,
	type PdfSealJobAction,
	type PdfSealJobStore,
	type PdfSealSealedArtifact
} from '$lib/ports/pdf-seal-job-store';
import {
	PdfSealProviderError,
	type PdfSealOperationReference,
	type PdfSealProvider,
	type PdfSealProviderOperation,
	type PdfSealResult,
	type PdfSealSucceededOperation
} from '$lib/ports/pdf-seal-provider';
import {
	PdfSealValidatorError,
	type PdfSealValidationChecks,
	type PdfSealValidationResult,
	type PdfSealValidator
} from '$lib/ports/pdf-seal-validator';
import {
	pdfSealSealedObjectKey,
	pdfSealValidationReportObjectKey,
	PdfSealService,
	type PdfSealBatchItemOutcome
} from './pdf-seal-service';

const NOW_ISO: string = '2026-09-23T00:00:00.000Z';

const baseChecks: PdfSealValidationChecks = {
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
	timestamp: null
};

/** In-memory double replicating the Postgres/D1 CAS transition semantics. */
class FakePdfSealJobStore implements PdfSealJobStore {
	readonly #jobs = new Map<string, PdfSealJob & { claimToken: string | null }>();

	seed(job: PdfSealJob): void {
		this.#jobs.set(job.jobId, { ...job, claimToken: null });
	}

	/** Simulates another worker stealing this lease out from under the caller. */
	stealClaim(jobId: string): void {
		const job = this.#jobs.get(jobId);
		if (job !== undefined) job.claimToken = 'stolen-by-another-worker';
	}

	async enqueue(command: EnqueuePdfSealJobCommand): Promise<EnqueuePdfSealJobResult> {
		assertValidPdfSealFrozenReference(command);
		const existing = [...this.#jobs.values()].find((job) => job.envelopeId === command.envelopeId);
		if (existing !== undefined) {
			return sameFrozenReference(existing, command)
				? { outcome: 'existing', job: toPublicJob(existing) }
				: { outcome: 'conflict' };
		}
		const job: PdfSealJob & { claimToken: string | null } = {
			jobId: command.jobId,
			envelopeId: command.envelopeId,
			operationId: command.operationId,
			validationId: command.validationId,
			sourceObjectKey: command.sourceObjectKey,
			sourceSha256: command.sourceSha256,
			sourceByteSize: command.sourceByteSize,
			requestedProfile: command.requestedProfile,
			signerCertificateSha256: command.signerCertificateSha256,
			sealPolicyId: command.sealPolicyId,
			validationPolicyId: command.validationPolicyId,
			tsaPolicyId: command.tsaPolicyId,
			tsaTrustBundleSha256: command.tsaTrustBundleSha256,
			status: 'pending',
			nextAction: 'submit',
			attemptSequence: 0,
			retryFailures: 0,
			availableAt: command.createdAt,
			lockedAt: null,
			retryable: null,
			lastErrorCode: null,
			providerReceiptId: null,
			sealedArtifact: null,
			validationEvidence: null,
			createdAt: command.createdAt,
			updatedAt: command.createdAt,
			readyAt: null,
			failedAt: null,
			claimToken: null
		};
		this.#jobs.set(job.jobId, job);
		return { outcome: 'enqueued', job: toPublicJob(job) };
	}

	async claim(command: ClaimPdfSealJobsCommand): Promise<readonly ClaimedPdfSealJob[]> {
		const limit: number = command.jobId === undefined ? boundPdfSealClaimLimit(command.limit) : 1;
		const eligible = [...this.#jobs.values()]
			.filter((job) => job.nextAction !== 'publish')
			.filter((job) => command.jobId === undefined || job.jobId === command.jobId)
			.filter((job) => isClaimable(job, command.claimedAt, command.staleBefore))
			.sort(
				(a, b) =>
					a.availableAt.localeCompare(b.availableAt) ||
					a.createdAt.localeCompare(b.createdAt) ||
					a.jobId.localeCompare(b.jobId)
			)
			.slice(0, limit);
		const claims: ClaimedPdfSealJob[] = [];
		for (const job of eligible) {
			job.status = 'processing';
			job.claimToken = command.claimToken;
			job.lockedAt = command.claimedAt;
			job.attemptSequence += 1;
			job.retryable = null;
			job.lastErrorCode = null;
			job.failedAt = null;
			job.updatedAt = command.claimedAt;
			claims.push({
				job: toPublicJob(job),
				claimToken: command.claimToken,
				startedAt: command.claimedAt
			});
		}
		return claims;
	}

	async checkpoint(command: PdfSealCheckpointCommand): Promise<boolean> {
		switch (command.kind) {
			case 'ambiguous_submit':
				return this.#transition(command, ['submit'], (job) => {
					job.status = 'pending';
					job.nextAction = 'recover_submit';
					job.claimToken = null;
					job.lockedAt = null;
					job.retryFailures = 0;
					job.availableAt = command.finishedAt;
					return true;
				});
			case 'provider_receipt':
				assertPdfSealProviderReceipt(command.providerReceiptId);
				return this.#transition(command, ['submit', 'recover_submit'], (job) => {
					job.status = 'pending';
					job.nextAction = 'poll_provider';
					job.claimToken = null;
					job.lockedAt = null;
					job.retryFailures = 0;
					job.providerReceiptId = command.providerReceiptId;
					job.availableAt = command.finishedAt;
					return true;
				});
			case 'provider_pending':
				assertPdfSealProviderReceipt(command.providerReceiptId);
				return this.#transition(command, ['poll_provider'], (job) => {
					if (job.providerReceiptId !== command.providerReceiptId) return false;
					job.status = 'pending';
					job.claimToken = null;
					job.lockedAt = null;
					job.retryFailures = 0;
					job.availableAt = pdfSealProviderPollAvailableAt(command.finishedAt);
					return true;
				});
			case 'provider_result':
				assertPdfSealProviderReceipt(command.providerReceiptId);
				return this.#transition(command, ['poll_provider'], (job) => {
					if (job.providerReceiptId !== command.providerReceiptId) return false;
					assertValidPdfSealArtifact(
						command.sealedArtifact,
						job.sourceByteSize,
						job.requestedProfile
					);
					job.status = 'pending';
					job.nextAction = 'validate';
					job.claimToken = null;
					job.lockedAt = null;
					job.retryFailures = 0;
					job.sealedArtifact = command.sealedArtifact;
					job.availableAt = command.finishedAt;
					return true;
				});
		}
	}

	async complete(command: CompletePdfSealJobCommand): Promise<boolean> {
		assertPdfSealProviderReceipt(command.providerReceiptId);
		return this.#transition(command, ['validate'], (job) => {
			if (job.providerReceiptId !== command.providerReceiptId) return false;
			if (!sameArtifact(job.sealedArtifact, command.sealedArtifact)) return false;
			assertValidPdfSealArtifact(command.sealedArtifact, job.sourceByteSize, job.requestedProfile);
			assertValidPdfSealValidationEvidence(command.validationEvidence, job.requestedProfile);
			job.status = 'publication_ready';
			job.nextAction = 'publish';
			job.claimToken = null;
			job.lockedAt = null;
			job.retryFailures = 0;
			job.validationEvidence = command.validationEvidence;
			job.readyAt = command.finishedAt;
			return true;
		});
	}

	async fail(command: FailPdfSealJobCommand): Promise<boolean> {
		assertPdfSealErrorCode(command.errorCode);
		return this.#transition(
			command,
			['submit', 'recover_submit', 'poll_provider', 'validate'],
			(job) => {
				if (command.retryable && job.retryFailures >= PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES) {
					return false;
				}
				const nextRetryFailures: number = command.retryable
					? job.retryFailures + 1
					: job.retryFailures;
				const retryable: boolean =
					command.retryable && nextRetryFailures < PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES;
				job.status = 'failed';
				job.claimToken = null;
				job.lockedAt = null;
				job.retryFailures = nextRetryFailures;
				job.retryable = retryable;
				job.lastErrorCode = command.errorCode;
				job.availableAt = retryable
					? pdfSealRetryAvailableAt(command.finishedAt, nextRetryFailures)
					: command.finishedAt;
				job.failedAt = retryable ? null : command.finishedAt;
				return true;
			}
		);
	}

	async find(jobId: string): Promise<PdfSealJob | null> {
		const job = this.#jobs.get(jobId);
		return job === undefined ? null : toPublicJob(job);
	}

	async findByEnvelopeId(envelopeId: string): Promise<PdfSealJob | null> {
		const job = [...this.#jobs.values()].find((candidate) => candidate.envelopeId === envelopeId);
		return job === undefined ? null : toPublicJob(job);
	}

	#transition(
		command: {
			jobId: string;
			claimToken: string;
			attemptId: string;
			attemptNumber: number;
			startedAt: string;
			finishedAt: string;
		},
		allowedActions: readonly PdfSealJobAction[],
		mutate: (job: PdfSealJob & { claimToken: string | null }) => boolean
	): boolean {
		assertPdfSealAttemptCommand(command);
		const job = this.#jobs.get(command.jobId);
		if (job === undefined) return false;
		if (
			job.status !== 'processing' ||
			job.claimToken !== command.claimToken ||
			job.attemptSequence !== command.attemptNumber ||
			job.lockedAt !== command.startedAt
		) {
			return false;
		}
		if (!allowedActions.includes(job.nextAction)) return false;
		if (!mutate(job)) return false;
		job.updatedAt = command.finishedAt;
		return true;
	}
}

function isClaimable(
	job: PdfSealJob & { claimToken: string | null },
	claimedAt: string,
	staleBefore: string
): boolean {
	if (job.status === 'pending') return job.availableAt <= claimedAt;
	if (job.status === 'failed') {
		return (
			job.retryable === true &&
			job.retryFailures < PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES &&
			job.availableAt <= claimedAt
		);
	}
	if (job.status === 'processing') return job.lockedAt !== null && job.lockedAt < staleBefore;
	return false;
}

function sameArtifact(
	current: PdfSealSealedArtifact | null,
	candidate: PdfSealSealedArtifact
): boolean {
	return (
		current !== null &&
		current.objectKey === candidate.objectKey &&
		current.sha256 === candidate.sha256 &&
		current.byteSize === candidate.byteSize &&
		current.achievedProfile === candidate.achievedProfile
	);
}

function sameFrozenReference(job: PdfSealJob, command: EnqueuePdfSealJobCommand): boolean {
	return (
		job.jobId === command.jobId &&
		job.operationId === command.operationId &&
		job.validationId === command.validationId &&
		job.sourceObjectKey === command.sourceObjectKey &&
		job.sourceSha256 === command.sourceSha256 &&
		job.sourceByteSize === command.sourceByteSize
	);
}

function toPublicJob(record: PdfSealJob & { claimToken: string | null }): PdfSealJob {
	const { claimToken, ...job } = record;
	void claimToken;
	return { ...job };
}

function referenceFieldsOf(job: PdfSealJob): PdfSealOperationReference {
	return {
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
}

async function seedJobWithSource(
	store: FakePdfSealJobStore,
	objects: InMemoryObjectStore,
	overrides: Partial<PdfSealJob> = {},
	sourceContent: string = 'source-pdf-bytes'
): Promise<PdfSealJob> {
	const envelopeId: string = overrides.envelopeId ?? newUuidV7();
	const sourceKey: string = `completion-artifacts/v1/envelopes/${envelopeId}/pdf.pdf`;
	const bytes: Uint8Array = new TextEncoder().encode(sourceContent);
	const sha256: string = await sha256Hex(bytes);
	objects.seed(sourceKey, bytes, sha256);
	const job: PdfSealJob = {
		jobId: newUuidV7(),
		envelopeId,
		operationId: newUuidV7(),
		validationId: newUuidV7(),
		status: 'pending',
		nextAction: 'submit',
		attemptSequence: 0,
		retryFailures: 0,
		availableAt: NOW_ISO,
		lockedAt: null,
		retryable: null,
		lastErrorCode: null,
		sourceObjectKey: sourceKey,
		sourceSha256: sha256,
		sourceByteSize: bytes.byteLength,
		requestedProfile: 'pades-b-b',
		signerCertificateSha256: 'b'.repeat(64),
		sealPolicyId: 'seal-policy-v1',
		validationPolicyId: 'validation-policy-v1',
		tsaPolicyId: null,
		tsaTrustBundleSha256: null,
		providerReceiptId: null,
		sealedArtifact: null,
		validationEvidence: null,
		createdAt: NOW_ISO,
		updatedAt: NOW_ISO,
		readyAt: null,
		failedAt: null,
		...overrides
	};
	store.seed(job);
	return job;
}

async function seedSealedObject(
	objects: InMemoryObjectStore,
	envelopeId: string,
	sealedContent: string
): Promise<PdfSealSealedArtifact> {
	const bytes: Uint8Array = new TextEncoder().encode(sealedContent);
	const sha256: string = await sha256Hex(bytes);
	const key: string = pdfSealSealedObjectKey(envelopeId, sha256);
	objects.seed(key, bytes, sha256);
	return { objectKey: key, sha256, byteSize: bytes.byteLength, achievedProfile: 'pades-b-b' };
}

function outcomeErrorCode(outcome: PdfSealBatchItemOutcome | null): string | undefined {
	return outcome !== null && 'errorCode' in outcome ? outcome.errorCode : undefined;
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
		total += result.value.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

describe('PdfSealService', () => {
	let store: FakePdfSealJobStore;
	let objects: InMemoryObjectStore;
	let submitMock: ReturnType<typeof vi.fn<PdfSealProvider['submit']>>;
	let getStatusMock: ReturnType<typeof vi.fn<PdfSealProvider['getStatus']>>;
	let recoverAmbiguousSubmitMock: ReturnType<
		typeof vi.fn<PdfSealProvider['recoverAmbiguousSubmit']>
	>;
	let readResultMock: ReturnType<typeof vi.fn<PdfSealProvider['readResult']>>;
	let validateMock: ReturnType<typeof vi.fn<PdfSealValidator['validate']>>;
	let provider: PdfSealProvider;
	let validator: PdfSealValidator;
	let claimTokenCounter: number;
	let service: PdfSealService;

	beforeEach(() => {
		store = new FakePdfSealJobStore();
		objects = new InMemoryObjectStore();
		submitMock = vi.fn();
		getStatusMock = vi.fn();
		recoverAmbiguousSubmitMock = vi.fn();
		readResultMock = vi.fn();
		validateMock = vi.fn();
		provider = {
			submit: submitMock,
			getStatus: getStatusMock,
			recoverAmbiguousSubmit: recoverAmbiguousSubmitMock,
			readResult: readResultMock
		};
		validator = { validate: validateMock };
		claimTokenCounter = 0;
		service = new PdfSealService(
			store,
			objects,
			provider,
			validator,
			() => new Date(NOW_ISO),
			() => `claim-token-${++claimTokenCounter}`,
			newUuidV7
		);
	});

	it('checkpoints a provider receipt after a fresh-stream submit', async () => {
		const job = await seedJobWithSource(store, objects);
		submitMock.mockResolvedValue({
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-1',
			status: 'pending'
		} satisfies PdfSealProviderOperation);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'submitted' });
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('pending');
		expect(updated?.nextAction).toBe('poll_provider');
		expect(updated?.providerReceiptId).toBe('receipt-1');

		expect(submitMock).toHaveBeenCalledTimes(1);
		const submittedSource = submitMock.mock.calls[0][0].source;
		const submittedBytes = await readAllBytes(submittedSource);
		expect(await sha256Hex(submittedBytes)).toBe(job.sourceSha256);
		// The verification read and the stream handed to the provider are separate reads.
		expect(objects.getCallsByKey.get(job.sourceObjectKey)).toBe(2);
	});

	it('checkpoints ambiguous_submit instead of failing on an ambiguous submit error', async () => {
		const job = await seedJobWithSource(store, objects);
		submitMock.mockRejectedValue(new PdfSealProviderError('network_error', true, true));

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'ambiguous_submit' });
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('pending');
		expect(updated?.nextAction).toBe('recover_submit');
		expect(updated?.providerReceiptId).toBeNull();
	});

	it('recovers an ambiguous submit without reopening the source object', async () => {
		const job = await seedJobWithSource(store, objects, { nextAction: 'recover_submit' });
		recoverAmbiguousSubmitMock.mockResolvedValue({
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-2',
			status: 'processing'
		} satisfies PdfSealProviderOperation);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'submitted' });
		expect(submitMock).not.toHaveBeenCalled();
		expect(objects.getCalls).toBe(0);
		const updated = await store.find(job.jobId);
		expect(updated?.nextAction).toBe('poll_provider');
		expect(updated?.providerReceiptId).toBe('receipt-2');
	});

	it('records an ambiguous recovery failure instead of leaving the lease to livelock', async () => {
		const job = await seedJobWithSource(store, objects, { nextAction: 'recover_submit' });
		recoverAmbiguousSubmitMock.mockRejectedValue(
			new PdfSealProviderError('provider_redirected', false, true)
		);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'provider_redirected'
		});
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('failed');
		expect(updated?.nextAction).toBe('recover_submit');
	});

	it('non-ambiguous submit errors fail the job with the provider code/retryability', async () => {
		const job = await seedJobWithSource(store, objects);
		submitMock.mockRejectedValue(
			new PdfSealProviderError('provider_authentication_failed', false, false)
		);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'provider_authentication_failed'
		});
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('failed');
		expect(updated?.retryable).toBe(false);
	});

	it('defers via provider_pending when the operation is still pending', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'poll_provider',
			providerReceiptId: 'receipt-3'
		});
		getStatusMock.mockResolvedValue({
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-3',
			status: 'pending'
		} satisfies PdfSealProviderOperation);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'provider_pending' });
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('pending');
		expect(updated?.nextAction).toBe('poll_provider');
		expect(updated?.availableAt).toBe(pdfSealProviderPollAvailableAt(NOW_ISO));
	});

	it('fails the job when the provider reports a failed operation', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'poll_provider',
			providerReceiptId: 'receipt-4'
		});
		getStatusMock.mockResolvedValue({
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-4',
			status: 'failed',
			errorCode: 'provider_rejected',
			retryable: false
		} satisfies PdfSealProviderOperation);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'provider_rejected'
		});
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('failed');
		expect(updated?.lastErrorCode).toBe('provider_rejected');
	});

	it('replaces an unsafe provider error with a fixed secret-free code', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'poll_provider',
			providerReceiptId: 'receipt-unsafe'
		});
		getStatusMock.mockResolvedValue({
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-unsafe',
			status: 'failed',
			errorCode: 'https://provider.example Bearer secret-value',
			retryable: true
		} satisfies PdfSealProviderOperation);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'pdf_seal_invalid_remote_error'
		});
		expect(JSON.stringify(outcome)).not.toContain('provider.example');
		expect(JSON.stringify(outcome)).not.toContain('secret-value');
	});

	it('fails closed when a provider changes frozen operation metadata', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'poll_provider',
			providerReceiptId: 'receipt-changed'
		});
		getStatusMock.mockResolvedValue({
			...referenceFieldsOf(job),
			sourceSha256: 'f'.repeat(64),
			providerReceiptId: 'receipt-changed',
			status: 'pending'
		} satisfies PdfSealProviderOperation);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'pdf_seal_provider_operation_mismatched'
		});
	});

	it('reconciles a successful provider result into an immutable sealed object', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'poll_provider',
			providerReceiptId: 'receipt-5'
		});
		const sealedBytes = new TextEncoder().encode('sealed-pdf-bytes-longer-than-source');
		const sealedSha256 = await sha256Hex(sealedBytes);
		const succeeded: PdfSealSucceededOperation = {
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-5',
			status: 'succeeded',
			achievedProfile: 'pades-b-b',
			resultSha256: sealedSha256,
			resultByteSize: sealedBytes.byteLength
		};
		getStatusMock.mockResolvedValue(succeeded);
		readResultMock.mockResolvedValue({
			bytes: sealedBytes,
			sha256: sealedSha256,
			byteSize: sealedBytes.byteLength,
			achievedProfile: 'pades-b-b',
			providerReceiptId: 'receipt-5'
		} satisfies PdfSealResult);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'sealed' });
		const updated = await store.find(job.jobId);
		expect(updated?.nextAction).toBe('validate');
		const expectedKey = pdfSealSealedObjectKey(job.envelopeId, sealedSha256);
		expect(updated?.sealedArtifact).toEqual({
			objectKey: expectedKey,
			sha256: sealedSha256,
			byteSize: sealedBytes.byteLength,
			achievedProfile: 'pades-b-b'
		});
		// A successful put response is not trusted on its own: the service has
		// already reopened and hashed the immutable object once before checkpointing.
		expect(objects.getCallsByKey.get(expectedKey)).toBe(1);
		const stored = await objects.get(expectedKey);
		expect(stored).not.toBeNull();
		expect(await readAllBytes(stored!)).toEqual(sealedBytes);
	});

	it('treats an uncertain write whose confirmation was lost as reconciled, not retried', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'poll_provider',
			providerReceiptId: 'receipt-6'
		});
		const sealedBytes = new TextEncoder().encode('sealed-pdf-bytes-with-lost-confirmation');
		const sealedSha256 = await sha256Hex(sealedBytes);
		getStatusMock.mockResolvedValue({
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-6',
			status: 'succeeded',
			achievedProfile: 'pades-b-b',
			resultSha256: sealedSha256,
			resultByteSize: sealedBytes.byteLength
		} satisfies PdfSealSucceededOperation);
		readResultMock.mockResolvedValue({
			bytes: sealedBytes,
			sha256: sealedSha256,
			byteSize: sealedBytes.byteLength,
			achievedProfile: 'pades-b-b',
			providerReceiptId: 'receipt-6'
		} satisfies PdfSealResult);
		objects.throwAfterNextPut = true;

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'sealed' });
		const key = pdfSealSealedObjectKey(job.envelopeId, sealedSha256);
		expect(objects.putCallsByKey.get(key)).toBe(1);
	});

	it('permanently fails when the readResult bytes mismatch the succeeded operation', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'poll_provider',
			providerReceiptId: 'receipt-7'
		});
		const sealedBytes = new TextEncoder().encode('sealed-pdf-bytes-mismatch-case');
		const sealedSha256 = await sha256Hex(sealedBytes);
		getStatusMock.mockResolvedValue({
			...referenceFieldsOf(job),
			providerReceiptId: 'receipt-7',
			status: 'succeeded',
			achievedProfile: 'pades-b-b',
			resultSha256: sealedSha256,
			resultByteSize: sealedBytes.byteLength
		} satisfies PdfSealSucceededOperation);
		readResultMock.mockResolvedValue({
			bytes: sealedBytes,
			sha256: 'f'.repeat(64),
			byteSize: sealedBytes.byteLength,
			achievedProfile: 'pades-b-b',
			providerReceiptId: 'receipt-7'
		} satisfies PdfSealResult);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'pdf_seal_provider_result_mismatched'
		});
	});

	it('permanently fails submit when the source object is missing', async () => {
		const job = await seedJobWithSource(store, objects);
		await objects.delete(job.sourceObjectKey);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'pdf_seal_source_object_missing'
		});
		expect(submitMock).not.toHaveBeenCalled();
	});

	it('permanently fails submit when the source object digest no longer matches', async () => {
		const job = await seedJobWithSource(store, objects, { sourceSha256: 'a'.repeat(64) });

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'pdf_seal_source_object_mismatched'
		});
	});

	it('permanently fails validate when the sealed object no longer matches', async () => {
		const job = await seedJobWithSource(store, objects, {
			nextAction: 'validate',
			providerReceiptId: 'receipt-8',
			sealedArtifact: {
				objectKey: 'pdf-seals/v1/envelopes/missing/sealed/sha256/deadbeef.pdf',
				sha256: 'c'.repeat(64),
				byteSize: 100,
				achievedProfile: 'pades-b-b'
			}
		});

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'pdf_seal_sealed_object_missing'
		});
		expect(validateMock).not.toHaveBeenCalled();
	});

	it('completes with a deterministic bounded validation report on a valid result', async () => {
		const job = await seedJobWithSource(store, objects);
		const sealedArtifact = await seedSealedObject(
			objects,
			job.envelopeId,
			'sealed-pdf-bytes-longer-than-the-source'
		);
		store.seed({
			...job,
			nextAction: 'validate',
			providerReceiptId: 'receipt-9',
			sealedArtifact
		});
		const validResult: PdfSealValidationResult = {
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
			validatorReceiptId: 'validator-1',
			status: 'valid',
			achievedProfile: 'pades-b-b',
			checks: {
				...baseChecks,
				ignoredRemoteProperty: 'must-not-enter-evidence'
			} as PdfSealValidationChecks
		};
		validateMock.mockResolvedValue(validResult);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'publication_ready' });
		// The batch DTO never exposes object keys or other internal evidence.
		expect(Object.keys(outcome as object).sort()).toEqual(['jobId', 'outcome']);

		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('publication_ready');
		expect(updated?.nextAction).toBe('publish');
		const evidence = updated?.validationEvidence;
		expect(evidence?.validatorReceiptId).toBe('validator-1');
		expect(evidence).not.toBeNull();
		// The validation report also crosses the same mandatory readback gate.
		expect(objects.getCallsByKey.get(evidence!.reportObjectKey)).toBe(1);
		const reportStream = await objects.get(evidence!.reportObjectKey);
		expect(reportStream).not.toBeNull();
		const reportBytes = await readAllBytes(reportStream!);
		expect(reportBytes.byteLength).toBe(evidence!.reportByteSize);
		expect(await sha256Hex(reportBytes)).toBe(evidence!.reportSha256);
		const parsed = JSON.parse(new TextDecoder().decode(reportBytes));
		expect(parsed).toMatchObject({
			jobId: job.jobId,
			envelopeId: job.envelopeId,
			validatorReceiptId: 'validator-1',
			achievedProfile: 'pades-b-b',
			signerCertificateSha256: job.signerCertificateSha256,
			sealPolicyId: job.sealPolicyId,
			validationPolicyId: job.validationPolicyId,
			tsaPolicyId: null,
			tsaTrustBundleSha256: null
		});
		expect(parsed).not.toHaveProperty('validatedAt');
		expect(parsed.checks).not.toHaveProperty('ignoredRemoteProperty');
		expect(evidence!.checks).not.toHaveProperty('ignoredRemoteProperty');
		expect(evidence!.reportObjectKey).toBe(
			pdfSealValidationReportObjectKey(job.envelopeId, job.jobId, evidence!.reportSha256)
		);

		// Re-running the same serialization is byte-for-byte identical (deterministic).
		const secondJson = JSON.stringify(parsed);
		expect(await sha256Hex(new TextEncoder().encode(secondJson))).toBe(evidence!.reportSha256);
	});

	it('permanently fails on an invalid validation with the first allowlisted failure code', async () => {
		const job = await seedJobWithSource(store, objects);
		const sealedArtifact = await seedSealedObject(
			objects,
			job.envelopeId,
			'sealed-pdf-bytes-invalid'
		);
		store.seed({ ...job, nextAction: 'validate', providerReceiptId: 'receipt-10', sealedArtifact });
		validateMock.mockResolvedValue({
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
			validatorReceiptId: 'validator-2',
			status: 'invalid',
			failureCodes: ['cms_signature_invalid', 'doc_mdp_forbidden']
		} satisfies PdfSealValidationResult);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'permanently_failed',
			errorCode: 'cms_signature_invalid'
		});
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('failed');
		expect(updated?.retryable).toBe(false);
	});

	it('retries on a retryable validator transport error', async () => {
		const job = await seedJobWithSource(store, objects);
		const sealedArtifact = await seedSealedObject(
			objects,
			job.envelopeId,
			'sealed-pdf-bytes-retry'
		);
		store.seed({ ...job, nextAction: 'validate', providerReceiptId: 'receipt-11', sealedArtifact });
		validateMock.mockRejectedValue(new PdfSealValidatorError('validator_unavailable', true));

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'retryable_failed',
			errorCode: 'validator_unavailable'
		});
		const updated = await store.find(job.jobId);
		expect(updated?.status).toBe('failed');
		expect(updated?.retryable).toBe(true);
		expect(updated?.availableAt).toBe(pdfSealRetryAvailableAt(NOW_ISO, 1));
	});

	it('reports a stale outcome when the lease is stolen before the checkpoint lands', async () => {
		const job = await seedJobWithSource(store, objects);
		submitMock.mockImplementation(async () => {
			store.stealClaim(job.jobId);
			return {
				...referenceFieldsOf(job),
				providerReceiptId: 'receipt-12',
				status: 'pending'
			} satisfies PdfSealProviderOperation;
		});

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({ jobId: job.jobId, outcome: 'stale' });
		// The stolen claim token proves the fake CAS check, not our own code, rejected it.
		const updated = await store.find(job.jobId);
		expect(updated?.providerReceiptId).toBeNull();
	});

	it('isolates one item and continues the batch at concurrency one', async () => {
		const jobA = await seedJobWithSource(store, objects, {}, 'source-a');
		const jobB = await seedJobWithSource(store, objects, {}, 'source-b');
		const order: string[] = [];
		submitMock.mockImplementation(async (command: { operationId: string }) => {
			order.push(`start:${command.operationId}`);
			if (command.operationId === jobA.operationId) {
				order.push(`end:${command.operationId}`);
				throw new Error('unexpected provider outage, not a typed PdfSealProviderError');
			}
			order.push(`end:${command.operationId}`);
			return {
				...referenceFieldsOf(jobB),
				providerReceiptId: 'receipt-b',
				status: 'pending'
			} satisfies PdfSealProviderOperation;
		});
		// Job A's own typed handling calls store.fail(); make that specific call
		// itself blow up (a store outage), so the failure genuinely escapes every
		// typed catch inside #submit and only the outer per-item isolation net in
		// processPendingBatch catches it — proving job B's processing is unaffected.
		vi.spyOn(store, 'fail').mockImplementationOnce(async () => {
			throw new Error('job store outage for the first fail() attempt only');
		});

		const result = await service.processPendingBatch(10);

		expect(result.claimed).toBe(2);
		expect(result.outcomes).toHaveLength(2);
		const outcomeA = result.outcomes.find((item) => item.jobId === jobA.jobId) ?? null;
		const outcomeB = result.outcomes.find((item) => item.jobId === jobB.jobId) ?? null;
		expect(outcomeA?.outcome).toBe('retryable_failed');
		expect(outcomeErrorCode(outcomeA)).toBe('pdf_seal_transient_failure');
		expect(outcomeB?.outcome).toBe('submitted');
		// The isolation catch never persists anything: job A's lease is simply
		// left to expire, it is not force-marked failed by the isolation net.
		const updatedA = await store.find(jobA.jobId);
		expect(updatedA?.status).toBe('processing');
		const updatedB = await store.find(jobB.jobId);
		expect(updatedB?.status).toBe('pending');
		expect(updatedB?.nextAction).toBe('poll_provider');
		// Strictly sequential: job A's submit call fully finishes before job B's starts.
		expect(order).toEqual([
			`start:${jobA.operationId}`,
			`end:${jobA.operationId}`,
			`start:${jobB.operationId}`,
			`end:${jobB.operationId}`
		]);
	});

	it('never leaks a raw error message, URL, or secret into a failure outcome', async () => {
		const job = await seedJobWithSource(store, objects);
		submitMock.mockRejectedValue(
			new Error('POST https://provider.example/pdf-seals/abc failed: Bearer eyJhbGciOi... leaked')
		);

		const outcome = await service.processJob(job.jobId);

		expect(outcome).toEqual({
			jobId: job.jobId,
			outcome: 'retryable_failed',
			errorCode: 'pdf_seal_transient_failure'
		});
		const serialized = JSON.stringify(outcome);
		expect(serialized).not.toMatch(/https?:\/\//);
		expect(serialized).not.toMatch(/Bearer/);
	});

	it('processPendingBatch returns an empty result when nothing is eligible', async () => {
		const result = await service.processPendingBatch(10);
		expect(result).toEqual({ claimed: 0, outcomes: [] });
	});

	it('processJob returns null when the job is not eligible for claim', async () => {
		const outcome = await service.processJob(newUuidV7());
		expect(outcome).toBeNull();
	});
});
