import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { PdfSealService } from './pdf-seal-service';
import type {
	EnqueuePdfSealJobResult,
	ClaimedPdfSealJob,
	PdfSealJob,
	PdfSealJobStore
} from '$lib/ports/pdf-seal-job-store';
import type {
	PdfSealAuditHead,
	PdfSealPublicationCandidate,
	PdfSealPublicationRecord,
	PdfSealPublicationStore,
	PublishPdfSealCommand,
	PublishPdfSealResult
} from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealValidationChecks } from '$lib/ports/pdf-seal-validator';
import { PdfSealDrainService } from './pdf-seal-drain-service';

const JOB_ID: string = '019a0000-0000-7000-8000-000000000001';
const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000002';
const AUDIT_EVENT_ID: string = '019a0000-0000-7000-8000-000000000099';
const SOURCE_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('source-pdf');
const SEALED_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('source-pdf-sealed');
const REPORT_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('{"valid":true}');

const checks: PdfSealValidationChecks = {
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

class ReadOnlyJobStore implements PdfSealJobStore {
	job: PdfSealJob | null;

	constructor(job: PdfSealJob | null) {
		this.job = job;
	}

	async find(jobId: string): Promise<PdfSealJob | null> {
		return this.job?.jobId === jobId ? structuredClone(this.job) : null;
	}

	async findByEnvelopeId(envelopeId: string): Promise<PdfSealJob | null> {
		return this.job?.envelopeId === envelopeId ? structuredClone(this.job) : null;
	}

	async enqueue(): Promise<EnqueuePdfSealJobResult> {
		throw new Error('not used');
	}

	async claim(): Promise<readonly ClaimedPdfSealJob[]> {
		throw new Error('not used');
	}

	async checkpoint(): Promise<boolean> {
		throw new Error('not used');
	}

	async complete(): Promise<boolean> {
		throw new Error('not used');
	}

	async fail(): Promise<boolean> {
		throw new Error('not used');
	}
}

class PublicationStore implements PdfSealPublicationStore {
	readonly commands: PublishPdfSealCommand[] = [];
	candidates: readonly PdfSealPublicationCandidate[] = [{ jobId: JOB_ID, envelopeId: ENVELOPE_ID }];
	auditHead: PdfSealAuditHead | null = {
		auditEventId: '019a0000-0000-7000-8000-000000000011',
		sequence: 4,
		eventHash: 'e'.repeat(64)
	};
	result: PublishPdfSealResult = {
		outcome: 'published',
		result: {
			jobId: JOB_ID,
			envelopeId: ENVELOPE_ID,
			sealedSha256: '',
			sealedByteSize: SEALED_BYTES.byteLength,
			achievedProfile: 'pades-b-b',
			validationReportSha256: '',
			validatedAt: '2026-09-23T00:05:30.000Z',
			publishedAt: '2026-09-23T00:06:00.000Z',
			auditEventId: AUDIT_EVENT_ID
		}
	};

	async discoverPdfSealPublicationCandidates(): Promise<readonly PdfSealPublicationCandidate[]> {
		return this.candidates;
	}

	async readAuditHeadForEnvelope(): Promise<PdfSealAuditHead | null> {
		return this.auditHead;
	}

	async publishPdfSeal(command: PublishPdfSealCommand): Promise<PublishPdfSealResult> {
		this.commands.push(command);
		return this.result;
	}

	async readPdfSealPublicationByEnvelope(): Promise<PdfSealPublicationRecord | null> {
		return null;
	}
}

async function fixture(): Promise<{
	job: PdfSealJob;
	jobs: ReadOnlyJobStore;
	publications: PublicationStore;
	objects: InMemoryObjectStore;
	processor: PdfSealService;
}> {
	const sourceSha256: string = await sha256Hex(SOURCE_BYTES);
	const sealedSha256: string = await sha256Hex(SEALED_BYTES);
	const reportSha256: string = await sha256Hex(REPORT_BYTES);
	const job: PdfSealJob = {
		jobId: JOB_ID,
		envelopeId: ENVELOPE_ID,
		operationId: '019a0000-0000-7000-8000-000000000003',
		validationId: '019a0000-0000-7000-8000-000000000004',
		sourceObjectKey: 'completion/source.pdf',
		sourceSha256,
		sourceByteSize: SOURCE_BYTES.byteLength,
		requestedProfile: 'pades-b-b',
		signerCertificateSha256: 'a'.repeat(64),
		sealPolicyId: 'seal-policy-v1',
		validationPolicyId: 'validation-policy-v1',
		tsaPolicyId: null,
		tsaTrustBundleSha256: null,
		status: 'publication_ready',
		nextAction: 'publish',
		attemptSequence: 4,
		retryFailures: 0,
		availableAt: '2026-09-23T00:05:30.000Z',
		lockedAt: null,
		retryable: null,
		lastErrorCode: null,
		providerReceiptId: 'provider-receipt',
		sealedArtifact: {
			objectKey: 'pdf-seals/sealed.pdf',
			sha256: sealedSha256,
			byteSize: SEALED_BYTES.byteLength,
			achievedProfile: 'pades-b-b'
		},
		validationEvidence: {
			validatorReceiptId: 'validator-receipt',
			checks,
			reportObjectKey: 'pdf-seals/reports/report.json',
			reportSha256,
			reportByteSize: REPORT_BYTES.byteLength,
			validatedAt: '2026-09-23T00:05:30.000Z'
		},
		createdAt: '2026-09-23T00:00:00.000Z',
		updatedAt: '2026-09-23T00:05:30.000Z',
		readyAt: '2026-09-23T00:05:30.000Z',
		failedAt: null
	};
	const objects = new InMemoryObjectStore();
	const sealedArtifact = job.sealedArtifact;
	const validationEvidence = job.validationEvidence;
	if (sealedArtifact === null || validationEvidence === null) throw new Error('invalid fixture');
	await objects.putImmutable(job.sourceObjectKey, {
		body: SOURCE_BYTES,
		contentType: 'application/pdf',
		sha256: sourceSha256
	});
	await objects.putImmutable(sealedArtifact.objectKey, {
		body: SEALED_BYTES,
		contentType: 'application/pdf',
		sha256: sealedSha256
	});
	await objects.putImmutable(validationEvidence.reportObjectKey, {
		body: REPORT_BYTES,
		contentType: 'application/json',
		sha256: reportSha256
	});
	const processor = {
		processPendingBatch: vi.fn().mockResolvedValue({ claimed: 0, outcomes: [] })
	} as unknown as PdfSealService;
	return {
		job,
		jobs: new ReadOnlyJobStore(job),
		publications: new PublicationStore(),
		objects,
		processor
	};
}

describe('PdfSealDrainService', () => {
	it('re-verifies every immutable object and publishes a secret-free chained event', async () => {
		const input = await fixture();
		const service = new PdfSealDrainService(
			input.processor,
			input.jobs,
			input.publications,
			input.objects,
			(): Date => new Date('2026-09-23T00:06:00.000Z'),
			(): string => AUDIT_EVENT_ID
		);
		const result = await service.drain(10);
		expect(result).toMatchObject({ publicationCandidates: 1, published: 1 });
		expect(input.publications.commands).toHaveLength(1);
		const command: PublishPdfSealCommand = input.publications.commands[0];
		expect(command.anchorAuditEventId).toBe(input.publications.auditHead?.auditEventId);
		expect(command.expectedAuditSequence).toBe(4);
		const payload = JSON.parse(command.auditPayloadJson) as Record<string, unknown>;
		expect(payload).toMatchObject({
			schemaVersion: 1,
			requestedProfile: 'pades-b-b',
			sealedSha256: input.job.sealedArtifact?.sha256,
			publishedAt: '2026-09-23T00:06:00.000Z'
		});
		expect(command.auditPayloadJson).not.toMatch(
			/provider-receipt|validator-receipt|completion\/source|pdf-seals\//
		);
		expect(command.auditEventHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it('fails closed before publication when any stored object mismatches', async () => {
		const input = await fixture();
		input.job.sealedArtifact = { ...input.job.sealedArtifact!, sha256: 'f'.repeat(64) };
		input.jobs.job = input.job;
		const service = new PdfSealDrainService(
			input.processor,
			input.jobs,
			input.publications,
			input.objects
		);
		const result = await service.drain();
		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(input.publications.commands).toHaveLength(0);
	});

	it('isolates a publication store failure and continues the bounded batch', async () => {
		const input = await fixture();
		input.publications.publishPdfSeal = vi.fn().mockRejectedValue(new Error('unavailable'));
		const service = new PdfSealDrainService(
			input.processor,
			input.jobs,
			input.publications,
			input.objects
		);
		await expect(service.drain()).resolves.toMatchObject({ retryableFailed: 1, published: 0 });
	});

	it('does not enqueue or auto-discover historical completion PDFs', async () => {
		const input = await fixture();
		input.publications.candidates = [];
		const enqueue = vi.spyOn(input.jobs, 'enqueue');
		const service = new PdfSealDrainService(
			input.processor,
			input.jobs,
			input.publications,
			input.objects
		);
		await expect(service.drain()).resolves.toMatchObject({ publicationCandidates: 0 });
		expect(enqueue).not.toHaveBeenCalled();
	});
});
