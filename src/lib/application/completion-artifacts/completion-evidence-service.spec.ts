import { describe, expect, it, vi } from 'vitest';
import type { CompletionArtifactStore } from '$lib/ports/completion-artifact-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectStore } from '$lib/ports/object-store';
import {
	CompletionEvidenceReadError,
	CompletionEvidenceService,
	completionEvidenceFailureLog
} from './completion-evidence-service';

const ENVELOPE_ID = '01900000-0000-7000-8000-000000000020';

function publishedStore(): CompletionArtifactStore {
	return {
		findCompletionArtifactStatus: vi.fn(async () => ({
			envelopeId: ENVELOPE_ID,
			envelopeCompleted: true,
			jobStatus: 'published',
			attempts: 1,
			lastError: null,
			availableAt: null,
			published: {
				manifestSha256: 'm'.repeat(64),
				jsonSha256: 'j'.repeat(64),
				markdownSha256: 'd'.repeat(64)
			}
		}))
	} as unknown as CompletionArtifactStore;
}

describe('CompletionEvidenceService', () => {
	it('throws a coded error without embedding the object key when JSON evidence is missing', async () => {
		const objects: ObjectStore = {
			get: vi.fn(async () => null)
		} as unknown as ObjectStore;
		const service = new CompletionEvidenceService(publishedStore(), objects, {
			readCompletionArtifactPdf: vi.fn(async () => null)
		} as unknown as CompletionArtifactPdfStore);
		await expect(service.readEvidence(ENVELOPE_ID, 'json')).rejects.toMatchObject({
			name: 'CompletionEvidenceReadError',
			code: 'artifact_object_missing'
		});
		await expect(service.readEvidence(ENVELOPE_ID, 'json')).rejects.toThrow(
			CompletionEvidenceReadError
		);
	});

	it('throws a coded error without embedding the PDF object key when the PDF is missing', async () => {
		const pdfKey = 'completion-artifacts/v1/envelopes/env/sha256/eeee.pdf';
		const objects: ObjectStore = {
			get: vi.fn(async () => null)
		} as unknown as ObjectStore;
		const service = new CompletionEvidenceService(publishedStore(), objects, {
			readCompletionArtifactPdf: vi.fn(async () => ({
				pdfObjectKey: pdfKey,
				pdfSha256: 'e'.repeat(64)
			}))
		} as unknown as CompletionArtifactPdfStore);
		try {
			await service.readPdf(ENVELOPE_ID);
			expect.unreachable('expected readPdf to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(CompletionEvidenceReadError);
			expect((error as CompletionEvidenceReadError).code).toBe('pdf_object_missing');
			expect((error as Error).message).not.toContain(pdfKey);
			expect((error as Error).message).not.toContain('completion-artifacts/');
		}
	});

	it('exposes only errorName and code for logs', () => {
		expect(
			completionEvidenceFailureLog(new CompletionEvidenceReadError('artifact_object_missing'))
		).toEqual({
			errorName: 'CompletionEvidenceReadError',
			code: 'artifact_object_missing'
		});
		expect(completionEvidenceFailureLog(new Error('object storage: secret-key'))).toEqual({
			errorName: 'Error'
		});
	});
});
