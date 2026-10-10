import { describe, expect, it, vi } from 'vitest';
import type {
	CompletionArtifactStatusRow,
	CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import type {
	CompletionArtifactPdfRepairStatusRow,
	CompletionArtifactPdfRepairStore
} from '$lib/ports/completion-artifact-pdf-repair-store';
import {
	CompletionArtifactStatusService,
	type PublicCompletionArtifactStatus
} from './completion-artifact-status';

const ENVELOPE_ID: string = 'envelope-1';

function pdfStore(record: CompletionArtifactPdfRecord | null): CompletionArtifactPdfStore {
	return {
		publishCompletionArtifactPdf: vi.fn(async () => {
			throw new Error('unused');
		}),
		readCompletionArtifactPdf: vi.fn(async () => record)
	};
}

function store(row: CompletionArtifactStatusRow | null): CompletionArtifactStore {
	return {
		findCompletionArtifactRetry: async () => null,
		claimPendingCompletionArtifacts: async () => [],
		readClaimedCompletionArtifact: async () => null,
		readCompletionEvidence: async () => {
			throw new Error('unused');
		},
		publishCompletionArtifact: async () => {
			throw new Error('unused');
		},
		failCompletionArtifact: async () => {
			throw new Error('unused');
		},
		requeueExhaustedCompletionArtifact: async () => {
			throw new Error('unused');
		},
		findCompletionArtifactStatus: async () => row
	};
}

function baseRow(
	overrides: Partial<CompletionArtifactStatusRow> = {}
): CompletionArtifactStatusRow {
	return {
		envelopeId: ENVELOPE_ID,
		envelopeCompleted: false,
		jobStatus: null,
		attempts: null,
		lastError: null,
		availableAt: null,
		updatedAt: null,
		published: null,
		...overrides
	};
}

describe('CompletionArtifactStatusService.find', () => {
	it('returns null when no status row exists for the envelope', async () => {
		const service = new CompletionArtifactStatusService(store(null));
		await expect(service.find(ENVELOPE_ID)).resolves.toBeNull();
	});

	it('reports not_completed for an envelope that has not completed and has no job', async () => {
		const service = new CompletionArtifactStatusService(
			store(baseRow({ envelopeCompleted: false }))
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({ envelopeId: ENVELOPE_ID, status: 'not_completed' });
	});

	// Regression: a completed envelope queried before the reconciliation job is
	// discovered must read as pending with zero attempts, never not_completed —
	// the envelope did complete, the worker just has not picked it up yet.
	it('reports pending with zero attempts for a completed envelope before its job is discovered', async () => {
		const service = new CompletionArtifactStatusService(
			store(baseRow({ envelopeCompleted: true, jobStatus: null }))
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({
			envelopeId: ENVELOPE_ID,
			status: 'pending',
			attempts: 0,
			availableAt: null
		});
	});

	it('reports the job attempts once a pending job row exists', async () => {
		const service = new CompletionArtifactStatusService(
			store(baseRow({ envelopeCompleted: true, jobStatus: 'pending', attempts: 2 }))
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({
			envelopeId: ENVELOPE_ID,
			status: 'pending',
			attempts: 2,
			availableAt: null
		});
	});

	it('reports processing with attempts', async () => {
		const service = new CompletionArtifactStatusService(
			store(baseRow({ envelopeCompleted: true, jobStatus: 'processing', attempts: 1 }))
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({
			envelopeId: ENVELOPE_ID,
			status: 'processing',
			attempts: 1,
			availableAt: null
		});
	});

	it('reports failed with a sanitized error code and retry time', async () => {
		const service = new CompletionArtifactStatusService(
			store(
				baseRow({
					envelopeCompleted: true,
					jobStatus: 'failed',
					attempts: 3,
					lastError: 'completion_artifact_build_failed',
					availableAt: '2026-09-12T00:05:00.000Z',
					updatedAt: '2026-09-12T00:00:00.000Z'
				})
			)
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({
			envelopeId: ENVELOPE_ID,
			status: 'failed',
			attempts: 3,
			errorCode: 'completion_artifact_build_failed',
			availableAt: '2026-09-12T00:05:00.000Z',
			failedAt: '2026-09-12T00:00:00.000Z',
			retryEligible: false
		});
	});

	function publishedRow(): CompletionArtifactStatusRow {
		return baseRow({
			envelopeCompleted: true,
			jobStatus: 'published',
			published: {
				envelopeId: ENVELOPE_ID,
				manifestSha256: 'm'.repeat(64),
				jsonSha256: 'j'.repeat(64),
				markdownSha256: 'd'.repeat(64),
				publishedAt: '2026-09-12T00:00:00.000Z',
				auditEventId: 'audit-event-1'
			}
		});
	}

	it('reports published with content digests and an unavailable PDF status when no PDF store is configured', async () => {
		const service = new CompletionArtifactStatusService(store(publishedRow()));
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({
			envelopeId: ENVELOPE_ID,
			status: 'published',
			publishedAt: '2026-09-12T00:00:00.000Z',
			manifestSha256: 'm'.repeat(64),
			jsonSha256: 'j'.repeat(64),
			markdownSha256: 'd'.repeat(64),
			pdfStatus: 'unavailable',
			pdfRepair: null,
			retryEligible: false
		});
	});

	it('reports a pending PDF status when the PDF store is configured but has not published a record yet', async () => {
		const service = new CompletionArtifactStatusService(store(publishedRow()), pdfStore(null));
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toMatchObject({ status: 'published', pdfStatus: 'pending' });
	});

	it('reports exhausted transient failures as retry-eligible without exposing leases', async () => {
		const service = new CompletionArtifactStatusService(
			store(
				baseRow({
					envelopeCompleted: true,
					jobStatus: 'failed',
					attempts: 10,
					lastError: 'completion_artifact_attempts_exhausted',
					availableAt: '2026-09-12T00:05:00.000Z',
					updatedAt: '2026-09-12T00:04:00.123456Z'
				})
			)
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toMatchObject({
			status: 'failed',
			retryEligible: true,
			errorCode: 'completion_artifact_attempts_exhausted',
			failedAt: '2026-09-12T00:04:00.123456Z'
		});
		expect(JSON.stringify(status)).not.toContain('claim');
	});

	function repairStatusStore(
		row: CompletionArtifactPdfRepairStatusRow | null
	): CompletionArtifactPdfRepairStore {
		return {
			claimPendingPdfRepairs: vi.fn(),
			readClaimedPdfRepair: vi.fn(),
			completePdfRepair: vi.fn(),
			failPdfRepair: vi.fn(),
			requeueExhaustedPdfRepair: vi.fn(),
			findPdfRepairStatus: async () => row
		};
	}

	it('reports a failed PDF repair without object keys and with retry eligibility only when exhausted', async () => {
		const service = new CompletionArtifactStatusService(
			store(publishedRow()),
			pdfStore(null),
			repairStatusStore({
				envelopeId: ENVELOPE_ID,
				status: 'failed',
				attempts: 10,
				lastError: 'completion_artifact_pdf_repair_attempts_exhausted',
				availableAt: '2026-09-12T00:05:00.000Z',
				retryable: false,
				updatedAt: '2026-09-12T00:05:00.000Z'
			})
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toMatchObject({
			status: 'published',
			pdfStatus: 'failed',
			retryEligible: true,
			pdfRepair: {
				status: 'failed',
				attempts: 10,
				availableAt: null,
				failedAt: '2026-09-12T00:05:00.000Z'
			}
		});
		expect(JSON.stringify(status)).not.toContain('completion-artifacts/');
	});

	it('reports a permanent PDF repair failure as failed but never retry-eligible', async () => {
		const service = new CompletionArtifactStatusService(
			store(publishedRow()),
			pdfStore(null),
			repairStatusStore({
				envelopeId: ENVELOPE_ID,
				status: 'failed',
				attempts: 1,
				lastError: 'completion_artifact_evidence_invalid',
				availableAt: '2026-09-12T00:05:00.000Z',
				retryable: false,
				updatedAt: '2026-09-12T00:05:00.000Z'
			})
		);
		await expect(service.find(ENVELOPE_ID)).resolves.toMatchObject({
			pdfStatus: 'failed',
			retryEligible: false
		});
	});

	it('reports a retryable PDF repair failure as pending with its next attempt, not failed', async () => {
		const service = new CompletionArtifactStatusService(
			store(publishedRow()),
			pdfStore(null),
			repairStatusStore({
				envelopeId: ENVELOPE_ID,
				status: 'failed',
				attempts: 2,
				lastError: 'completion_artifact_build_failed',
				availableAt: '2026-09-12T00:06:00.000Z',
				retryable: true,
				updatedAt: '2026-09-12T00:05:00.000Z'
			})
		);
		await expect(service.find(ENVELOPE_ID)).resolves.toMatchObject({
			pdfStatus: 'pending',
			retryEligible: false,
			pdfRepair: {
				status: 'pending',
				attempts: 2,
				availableAt: '2026-09-12T00:06:00.000Z',
				failedAt: null
			}
		});
	});

	it('reports a published PDF status once a PDF record exists, without exposing its object key or digest', async () => {
		const record: CompletionArtifactPdfRecord = {
			envelopeId: ENVELOPE_ID,
			pdfObjectKey: 'completion-artifacts/v1/envelopes/envelope-1/sha256/abc.pdf',
			pdfSha256: 'a'.repeat(64),
			pdfByteSize: 1024,
			pdfManifestObjectKey: 'completion-artifacts/v1/envelopes/envelope-1/sha256/abc.json.gz',
			pdfManifestSha256: 'a'.repeat(64),
			publishedAt: '2026-09-12T00:00:00.000Z'
		};
		const service = new CompletionArtifactStatusService(store(publishedRow()), pdfStore(record));
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toMatchObject({ status: 'published', pdfStatus: 'published' });
		expect(JSON.stringify(status)).not.toContain('completion-artifacts/');
		expect(JSON.stringify(status)).not.toContain(record.pdfSha256);
	});
});
