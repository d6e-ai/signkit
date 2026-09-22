import { describe, expect, it, vi } from 'vitest';
import type {
	CompletionArtifactStatusRow,
	CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
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
		expect(status).toEqual({ envelopeId: ENVELOPE_ID, status: 'pending', attempts: 0 });
	});

	it('reports the job attempts once a pending job row exists', async () => {
		const service = new CompletionArtifactStatusService(
			store(baseRow({ envelopeCompleted: true, jobStatus: 'pending', attempts: 2 }))
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({ envelopeId: ENVELOPE_ID, status: 'pending', attempts: 2 });
	});

	it('reports processing with attempts', async () => {
		const service = new CompletionArtifactStatusService(
			store(baseRow({ envelopeCompleted: true, jobStatus: 'processing', attempts: 1 }))
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({ envelopeId: ENVELOPE_ID, status: 'processing', attempts: 1 });
	});

	it('reports failed with a sanitized error code and retry time', async () => {
		const service = new CompletionArtifactStatusService(
			store(
				baseRow({
					envelopeCompleted: true,
					jobStatus: 'failed',
					attempts: 3,
					lastError: 'completion_artifact_build_failed',
					availableAt: '2026-09-12T00:05:00.000Z'
				})
			)
		);
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toEqual({
			envelopeId: ENVELOPE_ID,
			status: 'failed',
			attempts: 3,
			errorCode: 'completion_artifact_build_failed',
			availableAt: '2026-09-12T00:05:00.000Z'
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
			pdfStatus: 'unavailable'
		});
	});

	it('reports a pending PDF status when the PDF store is configured but has not published a record yet', async () => {
		const service = new CompletionArtifactStatusService(store(publishedRow()), pdfStore(null));
		const status: PublicCompletionArtifactStatus | null = await service.find(ENVELOPE_ID);
		expect(status).toMatchObject({ status: 'published', pdfStatus: 'pending' });
	});

	it('reports a published PDF status once a PDF record exists, without exposing its object key or digest', async () => {
		const record: CompletionArtifactPdfRecord = {
			pdfObjectKey: 'completion-artifacts/v1/envelopes/envelope-1/sha256/abc.pdf',
			pdfSha256: 'a'.repeat(64),
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
