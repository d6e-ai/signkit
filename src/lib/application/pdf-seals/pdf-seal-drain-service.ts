import { verifyImmutableObject } from '$lib/application/completion-artifacts/exact-object-stream';
import { hashAuditEventV3, PDF_SEAL_PUBLISHED_EVENT_TYPE } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type { ObjectStore } from '$lib/ports/object-store';
import type { PdfSealBatchResult, PdfSealService } from './pdf-seal-service';
import type { PdfSealJob, PdfSealJobStore } from '$lib/ports/pdf-seal-job-store';
import {
	boundPdfSealPublicationDiscoveryLimit,
	type PdfSealAuditHead,
	type PdfSealPublicationCandidate,
	type PdfSealPublicationStore,
	type PublishPdfSealCommand,
	type PublishPdfSealResult
} from '$lib/ports/pdf-seal-publication-store';

export const PDF_SEAL_DRAIN_BATCH_LIMIT: number = 10;
const PDF_SEAL_AUDIT_ACTOR_ID: string = 'pdf-seal-worker';

export type PdfSealPublicationItemOutcome =
	| { jobId: string; outcome: 'published' | 'replayed' | 'stale' }
	| { jobId: string; outcome: 'integrity_failed' | 'retryable_failed' };

export interface PdfSealDrainResult {
	processing: PdfSealBatchResult;
	publicationCandidates: number;
	published: number;
	replayed: number;
	stale: number;
	integrityFailed: number;
	retryableFailed: number;
	publicationOutcomes: readonly PdfSealPublicationItemOutcome[];
}

/**
 * Advances only explicitly enqueued jobs, then publishes validated evidence.
 * It deliberately does not discover completion PDFs or create jobs: automatic
 * historical sealing would blur the completion time and the later seal time.
 */
export class PdfSealDrainService {
	readonly #processor: PdfSealService;
	readonly #jobs: PdfSealJobStore;
	readonly #publications: PdfSealPublicationStore;
	readonly #objects: ObjectStore;
	readonly #now: () => Date;
	readonly #newId: UuidV7Generator;

	constructor(
		processor: PdfSealService,
		jobs: PdfSealJobStore,
		publications: PdfSealPublicationStore,
		objects: ObjectStore,
		now: () => Date = (): Date => new Date(),
		newId: UuidV7Generator = newUuidV7
	) {
		this.#processor = processor;
		this.#jobs = jobs;
		this.#publications = publications;
		this.#objects = objects;
		this.#now = now;
		this.#newId = newId;
	}

	async drain(limit: number = PDF_SEAL_DRAIN_BATCH_LIMIT): Promise<PdfSealDrainResult> {
		const boundedLimit: number = boundPdfSealPublicationDiscoveryLimit(limit);
		const processing: PdfSealBatchResult = await this.#processor.processPendingBatch(boundedLimit);
		const candidates: readonly PdfSealPublicationCandidate[] =
			await this.#publications.discoverPdfSealPublicationCandidates({ limit: boundedLimit });
		const publicationOutcomes: PdfSealPublicationItemOutcome[] = [];
		for (const candidate of candidates) {
			publicationOutcomes.push(await this.#publishIsolated(candidate));
		}
		return summarize(processing, candidates.length, publicationOutcomes);
	}

	async #publishIsolated(
		candidate: PdfSealPublicationCandidate
	): Promise<PdfSealPublicationItemOutcome> {
		try {
			return await this.#publish(candidate);
		} catch {
			return { jobId: candidate.jobId, outcome: 'retryable_failed' };
		}
	}

	async #publish(candidate: PdfSealPublicationCandidate): Promise<PdfSealPublicationItemOutcome> {
		const job: PdfSealJob | null = await this.#jobs.find(candidate.jobId);
		if (!isPublicationReady(job, candidate)) {
			return { jobId: candidate.jobId, outcome: 'stale' };
		}
		const snapshot: string = publicationSnapshot(job);
		// Verify sequentially: buffering the 32 MiB source and up-to-64 MiB
		// sealed PDF concurrently would leave too little headroom in a Worker.
		for (const artifact of [
			{
				key: job.sourceObjectKey,
				sha256: job.sourceSha256,
				byteSize: job.sourceByteSize
			},
			{
				key: job.sealedArtifact.objectKey,
				sha256: job.sealedArtifact.sha256,
				byteSize: job.sealedArtifact.byteSize
			},
			{
				key: job.validationEvidence.reportObjectKey,
				sha256: job.validationEvidence.reportSha256,
				byteSize: job.validationEvidence.reportByteSize
			}
		] as const) {
			if (
				(await verifyImmutableObject(
					this.#objects,
					artifact.key,
					artifact.sha256,
					artifact.byteSize
				)) !== 'verified'
			) {
				return { jobId: candidate.jobId, outcome: 'integrity_failed' };
			}
		}

		// Re-read the durable tuple after the comparatively slow object reads.
		// The store transaction checks it once more after this application check.
		const refreshed: PdfSealJob | null = await this.#jobs.find(candidate.jobId);
		if (!isPublicationReady(refreshed, candidate) || publicationSnapshot(refreshed) !== snapshot) {
			return { jobId: candidate.jobId, outcome: 'stale' };
		}
		const auditHead: PdfSealAuditHead | null = await this.#publications.readAuditHeadForEnvelope(
			candidate.envelopeId
		);
		if (auditHead === null) {
			return { jobId: candidate.jobId, outcome: 'integrity_failed' };
		}

		const publishedAt: string = this.#now().toISOString();
		const payload = pdfSealPublishedAuditPayload(refreshed, publishedAt);
		const auditPayloadJson: string = JSON.stringify(payload);
		const auditEventId: string = this.#newId();
		const auditEventHash: string = await hashAuditEventV3(
			{
				sequence: auditHead.sequence + 1,
				eventType: PDF_SEAL_PUBLISHED_EVENT_TYPE,
				actorType: 'system',
				actorId: PDF_SEAL_AUDIT_ACTOR_ID,
				occurredAt: publishedAt,
				payload,
				previousHash: auditHead.eventHash
			},
			{ envelopeId: candidate.envelopeId }
		);
		const command: PublishPdfSealCommand = {
			jobId: refreshed.jobId,
			envelopeId: refreshed.envelopeId,
			operationId: refreshed.operationId,
			validationId: refreshed.validationId,
			sourceObjectKey: refreshed.sourceObjectKey,
			sourceSha256: refreshed.sourceSha256,
			sourceByteSize: refreshed.sourceByteSize,
			requestedProfile: refreshed.requestedProfile,
			signerCertificateSha256: refreshed.signerCertificateSha256,
			sealPolicyId: refreshed.sealPolicyId,
			validationPolicyId: refreshed.validationPolicyId,
			tsaPolicyId: refreshed.tsaPolicyId,
			tsaTrustBundleSha256: refreshed.tsaTrustBundleSha256,
			providerReceiptId: refreshed.providerReceiptId,
			sealedArtifact: refreshed.sealedArtifact,
			validationEvidence: refreshed.validationEvidence,
			publishedAt,
			anchorAuditEventId: auditHead.auditEventId,
			expectedAuditSequence: auditHead.sequence,
			previousAuditHash: auditHead.eventHash,
			auditEventId,
			auditEventHash,
			auditPayloadJson
		};
		const result: PublishPdfSealResult = await this.#publications.publishPdfSeal(command);
		return mapPublishResult(candidate.jobId, result);
	}
}

function isPublicationReady(
	job: PdfSealJob | null,
	candidate: PdfSealPublicationCandidate
): job is PdfSealJob & {
	providerReceiptId: string;
	sealedArtifact: NonNullable<PdfSealJob['sealedArtifact']>;
	validationEvidence: NonNullable<PdfSealJob['validationEvidence']>;
} {
	return (
		job !== null &&
		job.jobId === candidate.jobId &&
		job.envelopeId === candidate.envelopeId &&
		job.status === 'publication_ready' &&
		job.nextAction === 'publish' &&
		job.providerReceiptId !== null &&
		job.sealedArtifact !== null &&
		job.validationEvidence !== null
	);
}

function publicationSnapshot(job: PdfSealJob): string {
	return JSON.stringify({
		jobId: job.jobId,
		envelopeId: job.envelopeId,
		operationId: job.operationId,
		validationId: job.validationId,
		status: job.status,
		nextAction: job.nextAction,
		sourceObjectKey: job.sourceObjectKey,
		sourceSha256: job.sourceSha256,
		sourceByteSize: job.sourceByteSize,
		requestedProfile: job.requestedProfile,
		signerCertificateSha256: job.signerCertificateSha256,
		sealPolicyId: job.sealPolicyId,
		validationPolicyId: job.validationPolicyId,
		tsaPolicyId: job.tsaPolicyId,
		tsaTrustBundleSha256: job.tsaTrustBundleSha256,
		providerReceiptId: job.providerReceiptId,
		sealedArtifact: job.sealedArtifact,
		validationEvidence: job.validationEvidence
	});
}

function pdfSealPublishedAuditPayload(
	job: PdfSealJob & {
		sealedArtifact: NonNullable<PdfSealJob['sealedArtifact']>;
		validationEvidence: NonNullable<PdfSealJob['validationEvidence']>;
	},
	publishedAt: string
): Readonly<Record<string, unknown>> {
	return {
		schemaVersion: 1,
		requestedProfile: job.requestedProfile,
		achievedProfile: job.sealedArtifact.achievedProfile,
		sourceSha256: job.sourceSha256,
		sealedSha256: job.sealedArtifact.sha256,
		sealedByteSize: job.sealedArtifact.byteSize,
		signerCertificateSha256: job.signerCertificateSha256,
		sealPolicyId: job.sealPolicyId,
		validationPolicyId: job.validationPolicyId,
		tsaPolicyId: job.tsaPolicyId,
		tsaTrustBundleSha256: job.tsaTrustBundleSha256,
		validationReportSha256: job.validationEvidence.reportSha256,
		validatedAt: job.validationEvidence.validatedAt,
		publishedAt
	};
}

function mapPublishResult(
	jobId: string,
	result: PublishPdfSealResult
): PdfSealPublicationItemOutcome {
	switch (result.outcome) {
		case 'published':
		case 'replayed':
		case 'stale':
			return { jobId, outcome: result.outcome };
		case 'integrity_error':
			return { jobId, outcome: 'integrity_failed' };
	}
}

function summarize(
	processing: PdfSealBatchResult,
	publicationCandidates: number,
	outcomes: readonly PdfSealPublicationItemOutcome[]
): PdfSealDrainResult {
	return {
		processing,
		publicationCandidates,
		published: count(outcomes, 'published'),
		replayed: count(outcomes, 'replayed'),
		stale: count(outcomes, 'stale'),
		integrityFailed: count(outcomes, 'integrity_failed'),
		retryableFailed: count(outcomes, 'retryable_failed'),
		publicationOutcomes: outcomes
	};
}

function count(
	outcomes: readonly PdfSealPublicationItemOutcome[],
	outcome: PdfSealPublicationItemOutcome['outcome']
): number {
	return outcomes.filter((item: PdfSealPublicationItemOutcome): boolean => item.outcome === outcome)
		.length;
}
