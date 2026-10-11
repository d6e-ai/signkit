import { describe, expect, it, vi } from 'vitest';
import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import type {
	CompletionArtifactStatusRow,
	CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { CompletionAccessReissueArtifactVerifier } from './completion-access-reissue-artifact-verifier';

const ENVELOPE_ID: string = 'envelope-1';

function mockObjectStore(objects: Map<string, Uint8Array> = new Map()): ObjectStore {
	return {
		head: vi.fn(async (key: string): Promise<ObjectMetadata | null> => {
			const bytes: Uint8Array | undefined = objects.get(key);
			if (bytes === undefined) return null;
			return {
				key,
				contentType: 'application/octet-stream',
				size: bytes.byteLength,
				sha256: await sha256Hex(bytes),
				version: null
			};
		}),
		get: vi.fn(async (key: string): Promise<ReadableStream<Uint8Array> | null> => {
			const bytes = objects.get(key);
			if (bytes === undefined) return null;
			return new ReadableStream<Uint8Array>({
				start(controller): void {
					controller.enqueue(Uint8Array.from(bytes));
					controller.close();
				}
			});
		}),
		putImmutable: vi.fn(async () => {
			throw new Error('unused');
		}),
		delete: vi.fn(async () => {
			throw new Error('unused');
		}),
		list: vi.fn(async () => {
			throw new Error('unused');
		}),
		deleteMany: vi.fn(async () => {
			throw new Error('unused');
		})
	};
}

function artifactStoreFixture(status: CompletionArtifactStatusRow | null): CompletionArtifactStore {
	return {
		claimPendingCompletionArtifacts: vi.fn(),
		readClaimedCompletionArtifact: vi.fn(),
		readCompletionEvidence: vi.fn(),
		publishCompletionArtifact: vi.fn(),
		failCompletionArtifact: vi.fn(),
		requeueExhaustedCompletionArtifact: vi.fn(),
		findCompletionArtifactRetry: vi.fn(),
		findCompletionArtifactStatus: vi.fn(async () => status)
	};
}

function pdfStoreFixture(record: CompletionArtifactPdfRecord | null): CompletionArtifactPdfStore {
	return {
		publishCompletionArtifactPdf: vi.fn(async () => {
			throw new Error('unused');
		}),
		readCompletionArtifactPdf: vi.fn(async () => record)
	};
}

async function seedArtifacts(): Promise<{
	objects: Map<string, Uint8Array>;
	status: CompletionArtifactStatusRow;
	pdfRecord: CompletionArtifactPdfRecord;
}> {
	const jsonBytes: Uint8Array = new TextEncoder().encode('{"gzip":"json"}');
	const markdownBytes: Uint8Array = new TextEncoder().encode('# markdown');
	const pdfBytes: Uint8Array = new TextEncoder().encode('%PDF-1.7 synthetic');
	const jsonSha256: string = await sha256Hex(jsonBytes);
	const markdownSha256: string = await sha256Hex(markdownBytes);
	const pdfSha256: string = await sha256Hex(pdfBytes);
	const objects = new Map<string, Uint8Array>([
		[completionArtifactObjectKey(ENVELOPE_ID, 'json', jsonSha256), jsonBytes],
		[completionArtifactObjectKey(ENVELOPE_ID, 'markdown', markdownSha256), markdownBytes],
		[completionArtifactObjectKey(ENVELOPE_ID, 'pdf', pdfSha256), pdfBytes]
	]);
	return {
		objects,
		status: {
			envelopeId: ENVELOPE_ID,
			envelopeCompleted: true,
			jobStatus: 'published',
			attempts: 0,
			lastError: null,
			availableAt: null,
			updatedAt: null,
			published: {
				envelopeId: ENVELOPE_ID,
				manifestSha256: 'm'.repeat(64),
				jsonSha256,
				markdownSha256,
				publishedAt: '2026-09-11T00:03:00.000Z',
				auditEventId: 'audit-1'
			}
		},
		pdfRecord: {
			envelopeId: ENVELOPE_ID,
			pdfObjectKey: completionArtifactObjectKey(ENVELOPE_ID, 'pdf', pdfSha256),
			pdfSha256,
			pdfByteSize: pdfBytes.byteLength,
			pdfManifestObjectKey: 'completion/pdf-manifest.json.gz',
			pdfManifestSha256: 'b'.repeat(64),
			publishedAt: '2026-09-11T00:03:00.000Z'
		}
	};
}

describe('CompletionAccessReissueArtifactVerifier', () => {
	it('verifies the manifest and PDF against actual object bytes', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(pdfRecord),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('verified');
		if (result.outcome !== 'verified') return;
		expect(result.pointer.jsonSha256).toBe(status.published?.jsonSha256);
		expect(result.pointer.markdownSha256).toBe(status.published?.markdownSha256);
		expect(result.pointer.pdfSha256).toBe(pdfRecord.pdfSha256);
	});

	it('reports unpublished when no completion artifact has been published', async () => {
		const { objects, pdfRecord } = await seedArtifacts();
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(null),
			pdfStoreFixture(pdfRecord),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('unpublished');
	});

	it('reports unpublished when the manifest is published but the PDF is not', async () => {
		const { objects, status } = await seedArtifacts();
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(null),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('unpublished');
	});

	it('rejects a digest mismatch between the database pointer and actual object bytes', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		const key: string = completionArtifactObjectKey(ENVELOPE_ID, 'pdf', pdfRecord.pdfSha256);
		objects.set(key, new TextEncoder().encode('tampered bytes'));
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(pdfRecord),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('integrity_error');
		if (result.outcome !== 'integrity_error') return;
		expect(result.errorCode).toBe('completion_pdf_metadata_mismatch');
	});

	it('reports a retryable error when the PDF object is actually missing from storage', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		const key: string = completionArtifactObjectKey(ENVELOPE_ID, 'pdf', pdfRecord.pdfSha256);
		objects.delete(key);
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(pdfRecord),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('retryable_error');
		if (result.outcome !== 'retryable_error') return;
		expect(result.errorCode).toBe('completion_pdf_object_missing');
	});

	it('rejects a corrupt markdown object whose bytes no longer hash to the recorded digest', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		const key: string = completionArtifactObjectKey(
			ENVELOPE_ID,
			'markdown',
			status.published!.markdownSha256
		);
		const original: Uint8Array = objects.get(key)!;
		const corrupted: Uint8Array = new Uint8Array(original.byteLength);
		corrupted.set(original);
		corrupted[0] = corrupted[0] ^ 0xff;
		objects.set(key, corrupted);
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(pdfRecord),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('integrity_error');
		if (result.outcome !== 'integrity_error') return;
		expect(result.errorCode).toBe('completion_markdown_metadata_mismatch');
	});
});
