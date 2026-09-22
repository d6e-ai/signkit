import { gzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { CompletionArtifactStore } from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { completionArtifactObjectKey } from './completion-artifact-service';
import { sha256Hex } from './completion-manifest';
import {
	MAX_EVIDENCE_SUMMARY_PDF_BYTES,
	MAX_PUBLISHED_COMPLETION_PDF_BYTES
} from './completion-pdf-limits';
import {
	CompletionEvidenceReadError,
	CompletionEvidenceService,
	completionEvidenceFailureLog
} from './completion-evidence-service';

const ENVELOPE_ID = '01900000-0000-7000-8000-000000000020';

function publishedStore(overrides: {
	jsonSha256?: string;
	markdownSha256?: string;
}): CompletionArtifactStore {
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
				jsonSha256: overrides.jsonSha256 ?? 'j'.repeat(64),
				markdownSha256: overrides.markdownSha256 ?? 'd'.repeat(64)
			}
		}))
	} as unknown as CompletionArtifactStore;
}

function mockObjectStore(objects: Map<string, Uint8Array> = new Map()): ObjectStore {
	return {
		head: vi.fn(async (key: string): Promise<ObjectMetadata | null> => {
			const bytes: Uint8Array | undefined = objects.get(key);
			if (bytes === undefined) return null;
			return {
				key,
				contentType: 'application/pdf',
				size: bytes.byteLength,
				sha256: await sha256Hex(bytes),
				version: null
			};
		}),
		get: vi.fn(async (key: string): Promise<ReadableStream<Uint8Array> | null> => {
			const bytes = objects.get(key);
			if (!bytes) return null;
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

function pdfStoreFixture(record: CompletionArtifactPdfRecord | null): CompletionArtifactPdfStore {
	return {
		publishCompletionArtifactPdf: vi.fn(async () => {
			throw new Error('unused');
		}),
		readCompletionArtifactPdf: vi.fn(async () => record)
	};
}

describe('CompletionEvidenceService', () => {
	describe('readEvidence', () => {
		it('returns verified decompressed JSON evidence when the gzip hash matches the published digest', async () => {
			const content = JSON.stringify({ hello: 'world' });
			const gzipped = gzipSync(new TextEncoder().encode(content), { level: 9, mtime: 0 });
			const digest = await sha256Hex(gzipped);
			const key = completionArtifactObjectKey(ENVELOPE_ID, 'json', digest);
			const service = new CompletionEvidenceService(
				publishedStore({ jsonSha256: digest }),
				mockObjectStore(new Map([[key, gzipped]])),
				pdfStoreFixture(null)
			);
			await expect(service.readEvidence(ENVELOPE_ID, 'json')).resolves.toEqual({
				content,
				contentType: 'application/json',
				digest
			});
		});

		it('returns verified decompressed Markdown evidence, preserving non-ASCII text', async () => {
			const content = '# 完了証明\n- タイトル: テスト契約書';
			const gzipped = gzipSync(new TextEncoder().encode(content), { level: 9, mtime: 0 });
			const digest = await sha256Hex(gzipped);
			const key = completionArtifactObjectKey(ENVELOPE_ID, 'markdown', digest);
			const service = new CompletionEvidenceService(
				publishedStore({ markdownSha256: digest }),
				mockObjectStore(new Map([[key, gzipped]])),
				pdfStoreFixture(null)
			);
			await expect(service.readEvidence(ENVELOPE_ID, 'markdown')).resolves.toEqual({
				content,
				contentType: 'text/markdown; charset=utf-8',
				digest
			});
		});

		it('fails closed when the published digest is not a well-formed SHA-256 hex string', async () => {
			const service = new CompletionEvidenceService(
				publishedStore({ jsonSha256: 'not-a-hash' }),
				mockObjectStore(),
				pdfStoreFixture(null)
			);
			await expect(service.readEvidence(ENVELOPE_ID, 'json')).rejects.toMatchObject({
				name: 'CompletionEvidenceReadError',
				code: 'artifact_digest_invalid'
			});
		});

		it('throws a coded error without embedding the object key when JSON evidence is missing', async () => {
			const service = new CompletionEvidenceService(
				publishedStore({ jsonSha256: 'a'.repeat(64) }),
				mockObjectStore(),
				pdfStoreFixture(null)
			);
			await expect(service.readEvidence(ENVELOPE_ID, 'json')).rejects.toMatchObject({
				name: 'CompletionEvidenceReadError',
				code: 'artifact_object_missing'
			});
			await expect(service.readEvidence(ENVELOPE_ID, 'json')).rejects.toThrow(
				CompletionEvidenceReadError
			);
		});

		it('fails closed when the stored gzip bytes no longer hash to the published digest', async () => {
			const original = gzipSync(new TextEncoder().encode('original'), { level: 9, mtime: 0 });
			const digest = await sha256Hex(original);
			const key = completionArtifactObjectKey(ENVELOPE_ID, 'json', digest);
			const tampered = gzipSync(new TextEncoder().encode('tampered'), { level: 9, mtime: 0 });
			const service = new CompletionEvidenceService(
				publishedStore({ jsonSha256: digest }),
				mockObjectStore(new Map([[key, tampered]])),
				pdfStoreFixture(null)
			);
			await expect(service.readEvidence(ENVELOPE_ID, 'json')).rejects.toMatchObject({
				name: 'CompletionEvidenceReadError',
				code: 'artifact_integrity_mismatch'
			});
		});
	});

	describe('readPdf', () => {
		function pdfRecord(pdfBytes: Uint8Array, sha256: string): CompletionArtifactPdfRecord {
			return {
				pdfObjectKey: completionArtifactObjectKey(ENVELOPE_ID, 'pdf', sha256),
				pdfSha256: sha256,
				pdfByteSize: pdfBytes.byteLength,
				pdfManifestObjectKey: completionArtifactObjectKey(ENVELOPE_ID, 'pdf-manifest', sha256),
				pdfManifestSha256: sha256,
				publishedAt: '2026-09-12T12:00:00.000Z'
			};
		}

		it('returns verified PDF bytes when the object hash matches the published digest', async () => {
			const pdfBytes = new TextEncoder().encode('%PDF-1.7 fixture');
			const sha256 = await sha256Hex(pdfBytes);
			const record = pdfRecord(pdfBytes, sha256);
			const service = new CompletionEvidenceService(
				publishedStore({}),
				mockObjectStore(new Map([[record.pdfObjectKey, pdfBytes]])),
				pdfStoreFixture(record)
			);
			await expect(service.readPdf(ENVELOPE_ID)).resolves.toEqual({
				bytes: pdfBytes,
				sha256
			});
		});

		it('reads an executed PDF larger than the evidence-summary ceiling', async () => {
			const pdfBytes = new Uint8Array(MAX_EVIDENCE_SUMMARY_PDF_BYTES + 1);
			pdfBytes.set(new TextEncoder().encode('%PDF-1.7'));
			const sha256 = await sha256Hex(pdfBytes);
			const record = pdfRecord(pdfBytes, sha256);
			const service = new CompletionEvidenceService(
				publishedStore({}),
				mockObjectStore(new Map([[record.pdfObjectKey, pdfBytes]])),
				pdfStoreFixture(record)
			);

			await expect(service.readPdf(ENVELOPE_ID)).resolves.toMatchObject({ sha256 });
		});

		it('rejects metadata over the published limit before reading the object body', async () => {
			const sha256: string = 'a'.repeat(64);
			const record = pdfRecord(new Uint8Array(), sha256);
			const objects = mockObjectStore();
			vi.mocked(objects.head).mockResolvedValue({
				key: record.pdfObjectKey,
				contentType: 'application/pdf',
				size: MAX_PUBLISHED_COMPLETION_PDF_BYTES + 1,
				sha256,
				version: null
			});
			const service = new CompletionEvidenceService(
				publishedStore({}),
				objects,
				pdfStoreFixture(record)
			);

			await expect(service.readPdf(ENVELOPE_ID)).rejects.toMatchObject({
				code: 'stream_too_large'
			});
			expect(objects.get).not.toHaveBeenCalled();
		});

		it.each([
			['short', 1],
			['long', -1]
		])('rejects a %s object stream relative to its attested size', async (_label, delta) => {
			const pdfBytes = new TextEncoder().encode('%PDF-1.7 fixture');
			const sha256 = await sha256Hex(pdfBytes);
			const record = pdfRecord(pdfBytes, sha256);
			const objects = mockObjectStore(new Map([[record.pdfObjectKey, pdfBytes]]));
			vi.mocked(objects.head).mockResolvedValue({
				key: record.pdfObjectKey,
				contentType: 'application/pdf',
				size: pdfBytes.byteLength + delta,
				sha256,
				version: null
			});
			const service = new CompletionEvidenceService(
				publishedStore({}),
				objects,
				pdfStoreFixture(record)
			);

			await expect(service.readPdf(ENVELOPE_ID)).rejects.toMatchObject({
				code: 'pdf_integrity_mismatch'
			});
		});

		it('returns null when no PDF has been published', async () => {
			const service = new CompletionEvidenceService(
				publishedStore({}),
				mockObjectStore(),
				pdfStoreFixture(null)
			);
			await expect(service.readPdf(ENVELOPE_ID)).resolves.toBeNull();
		});

		it('fails closed when the published PDF digest is not a well-formed SHA-256 hex string', async () => {
			const record: CompletionArtifactPdfRecord = {
				pdfObjectKey: 'completion-artifacts/v1/envelopes/env/sha256/bad.pdf',
				pdfSha256: 'not-a-hash',
				pdfByteSize: 1024,
				pdfManifestObjectKey: 'unused',
				pdfManifestSha256: 'unused',
				publishedAt: '2026-09-12T12:00:00.000Z'
			};
			const service = new CompletionEvidenceService(
				publishedStore({}),
				mockObjectStore(),
				pdfStoreFixture(record)
			);
			try {
				await service.readPdf(ENVELOPE_ID);
				expect.unreachable('expected readPdf to throw');
			} catch (error) {
				expect(error).toBeInstanceOf(CompletionEvidenceReadError);
				expect((error as CompletionEvidenceReadError).code).toBe('pdf_digest_invalid');
			}
		});

		it('fails closed when the stored object key does not match the digest-derived key', async () => {
			const pdfBytes = new TextEncoder().encode('%PDF-1.7 fixture');
			const sha256 = await sha256Hex(pdfBytes);
			const record: CompletionArtifactPdfRecord = {
				pdfObjectKey: 'completion-artifacts/v1/envelopes/env/sha256/wrong-key.pdf',
				pdfSha256: sha256,
				pdfByteSize: pdfBytes.byteLength,
				pdfManifestObjectKey: 'unused',
				pdfManifestSha256: 'unused',
				publishedAt: '2026-09-12T12:00:00.000Z'
			};
			const service = new CompletionEvidenceService(
				publishedStore({}),
				mockObjectStore(new Map([[record.pdfObjectKey, pdfBytes]])),
				pdfStoreFixture(record)
			);
			try {
				await service.readPdf(ENVELOPE_ID);
				expect.unreachable('expected readPdf to throw');
			} catch (error) {
				expect(error).toBeInstanceOf(CompletionEvidenceReadError);
				expect((error as CompletionEvidenceReadError).code).toBe('pdf_key_mismatch');
			}
		});

		it('throws a coded error without embedding the PDF object key when the PDF object is missing', async () => {
			const pdfBytes = new TextEncoder().encode('%PDF-1.7 fixture');
			const sha256 = await sha256Hex(pdfBytes);
			const record = pdfRecord(pdfBytes, sha256);
			const service = new CompletionEvidenceService(
				publishedStore({}),
				mockObjectStore(),
				pdfStoreFixture(record)
			);
			try {
				await service.readPdf(ENVELOPE_ID);
				expect.unreachable('expected readPdf to throw');
			} catch (error) {
				expect(error).toBeInstanceOf(CompletionEvidenceReadError);
				expect((error as CompletionEvidenceReadError).code).toBe('pdf_object_missing');
				expect((error as Error).message).not.toContain(record.pdfObjectKey);
				expect((error as Error).message).not.toContain('completion-artifacts/');
			}
		});

		it('fails closed when the stored PDF bytes no longer hash to the published digest', async () => {
			const original = new TextEncoder().encode('%PDF-1.7 original');
			const sha256 = await sha256Hex(original);
			const record = pdfRecord(original, sha256);
			const tampered = new TextEncoder().encode('%PDF-1.7 tampered!');
			const objects = mockObjectStore(new Map([[record.pdfObjectKey, tampered]]));
			vi.mocked(objects.head).mockResolvedValue({
				key: record.pdfObjectKey,
				contentType: 'application/pdf',
				size: tampered.byteLength,
				sha256,
				version: null
			});
			const service = new CompletionEvidenceService(
				publishedStore({}),
				objects,
				pdfStoreFixture(record)
			);
			try {
				await service.readPdf(ENVELOPE_ID);
				expect.unreachable('expected readPdf to throw');
			} catch (error) {
				expect(error).toBeInstanceOf(CompletionEvidenceReadError);
				expect((error as CompletionEvidenceReadError).code).toBe('pdf_integrity_mismatch');
			}
		});
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
