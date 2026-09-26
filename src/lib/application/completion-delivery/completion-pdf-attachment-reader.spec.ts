import { describe, expect, it, vi } from 'vitest';
import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore,
	PublishCompletionArtifactPdfResult
} from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import {
	CompletionPdfAttachmentReader,
	MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES,
	MissingCompletionPdfAttachmentReader
} from './completion-pdf-attachment-reader';

const ENVELOPE_ID: string = '018f6e2a-1234-7000-8000-000000000001';
const OTHER_ENVELOPE_ID: string = '018f6e2a-1234-7000-8000-000000000002';

class FakePdfStore implements CompletionArtifactPdfStore {
	record: CompletionArtifactPdfRecord | null = null;
	shouldThrow = false;

	async publishCompletionArtifactPdf(): Promise<PublishCompletionArtifactPdfResult> {
		return { outcome: 'published' };
	}

	async readCompletionArtifactPdf(): Promise<CompletionArtifactPdfRecord | null> {
		if (this.shouldThrow) throw new Error('database unavailable');
		return this.record;
	}
}

async function publish(
	objects: InMemoryObjectStore,
	bytes: Uint8Array,
	byteSize: number | null = null,
	envelopeId: string = ENVELOPE_ID
): Promise<CompletionArtifactPdfRecord> {
	const sha256: string = await sha256Hex(bytes);
	const key: string = completionArtifactObjectKey(envelopeId, 'pdf', sha256);
	objects.seed(key, bytes, sha256);
	return {
		envelopeId,
		pdfObjectKey: key,
		pdfSha256: sha256,
		pdfByteSize: byteSize ?? bytes.byteLength,
		pdfManifestObjectKey: completionArtifactObjectKey(envelopeId, 'pdf-manifest', sha256),
		pdfManifestSha256: sha256,
		publishedAt: '2026-09-12T00:00:00.000Z'
	};
}

describe('CompletionPdfAttachmentReader', () => {
	it('fails closed as retryable when storage is not configured', async () => {
		await expect(new MissingCompletionPdfAttachmentReader().read()).resolves.toEqual({
			outcome: 'retryable_error',
			errorCode: 'completion_pdf_storage_not_configured'
		});
	});

	it('rejects a record belonging to another envelope before accessing storage', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		store.record = await publish(objects, Uint8Array.from([1, 2, 3, 4]), null, OTHER_ENVELOPE_ID);
		const head = vi.spyOn(objects, 'head');
		await expect(
			new CompletionPdfAttachmentReader(store, objects).read(ENVELOPE_ID)
		).resolves.toEqual({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_envelope_mismatch'
		});
		expect(head).not.toHaveBeenCalled();
		expect(objects.getCalls).toBe(0);
	});

	it.each([0, -1, 0.5, NaN, Infinity])(
		'rejects invalid recorded byte size %s',
		async (size: number) => {
			const store = new FakePdfStore();
			const objects = new InMemoryObjectStore();
			store.record = { ...(await publish(objects, new Uint8Array(4))), pdfByteSize: size };
			const head = vi.spyOn(objects, 'head');
			await expect(
				new CompletionPdfAttachmentReader(store, objects).read(ENVELOPE_ID)
			).resolves.toEqual({
				outcome: 'integrity_error',
				errorCode: 'completion_pdf_byte_size_invalid'
			});
			expect(head).not.toHaveBeenCalled();
		}
	);

	it.each([0, -1, 0.5, NaN, Infinity, MAX_PUBLISHED_COMPLETION_PDF_BYTES + 1])(
		'rejects invalid or out-of-publication-bound object size %s before reading bytes',
		async (size: number) => {
			const store = new FakePdfStore();
			const objects = new InMemoryObjectStore();
			store.record = { ...(await publish(objects, new Uint8Array(4))), pdfByteSize: null };
			const original = await objects.head(store.record.pdfObjectKey);
			if (original === null) throw new Error('Expected seeded metadata');
			vi.spyOn(objects, 'head').mockResolvedValue({ ...original, size });
			await expect(
				new CompletionPdfAttachmentReader(store, objects).read(ENVELOPE_ID)
			).resolves.toEqual({
				outcome: 'integrity_error',
				errorCode: 'completion_pdf_metadata_mismatch'
			});
			expect(objects.getCalls).toBe(0);
		}
	);

	it('treats disappearance after HEAD as retryable instead of sending link-only', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		store.record = await publish(objects, new Uint8Array(4));
		vi.spyOn(objects, 'get').mockResolvedValue(null);
		await expect(
			new CompletionPdfAttachmentReader(store, objects).read(ENVELOPE_ID)
		).resolves.toEqual({
			outcome: 'retryable_error',
			errorCode: 'completion_pdf_object_missing'
		});
	});

	it('treats a GET storage outage as retryable', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		store.record = await publish(objects, new Uint8Array(4));
		vi.spyOn(objects, 'get').mockRejectedValue(new Error('Storage unavailable'));
		await expect(
			new CompletionPdfAttachmentReader(store, objects).read(ENVELOPE_ID)
		).resolves.toEqual({
			outcome: 'retryable_error',
			errorCode: 'completion_pdf_storage_unavailable'
		});
	});

	it('reports unpublished when no PDF record exists yet', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({ outcome: 'unpublished' });
	});

	it('returns the exact byte-preserved PDF when everything verifies', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const bytes: Uint8Array = Uint8Array.from([
			0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0xff, 0x00, 0x7f
		]);
		store.record = await publish(objects, bytes);
		const reader = new CompletionPdfAttachmentReader(store, objects);

		const result = await reader.read(ENVELOPE_ID);
		expect(result.outcome).toBe('attached');
		if (result.outcome === 'attached') {
			expect(result.bytes).toEqual(bytes);
			expect(result.byteSize).toBe(bytes.byteLength);
		}
	});

	it('fails closed when recorded size claims oversize but verified object metadata is smaller', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const bytes: Uint8Array = new Uint8Array(16);
		store.record = await publish(objects, bytes, MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES + 1);
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_metadata_mismatch'
		});
	});

	it('reports oversize when verified object metadata exceeds the attachment budget', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const bytes: Uint8Array = new Uint8Array(MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES + 1);
		store.record = await publish(objects, bytes, bytes.byteLength);
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'oversize',
			byteSize: bytes.byteLength
		});
		expect(objects.getCalls).toBe(0);
	});

	it('reports oversize using the object metadata size when the durable byte size is null', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const bytes: Uint8Array = new Uint8Array(MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES + 10);
		store.record = { ...(await publish(objects, bytes)), pdfByteSize: null };
		const reader = new CompletionPdfAttachmentReader(store, objects);

		const result = await reader.read(ENVELOPE_ID);
		expect(result).toEqual({ outcome: 'oversize', byteSize: bytes.byteLength });
	});

	it('fails closed on a digest that does not match the pattern', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		store.record = { ...(await publish(objects, new Uint8Array(4))), pdfSha256: 'not-a-digest' };
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_digest_invalid'
		});
	});

	it('fails closed when the stored object key does not match the content-addressed key derived from the digest', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const record = await publish(objects, new Uint8Array(4));
		store.record = {
			...record,
			pdfObjectKey: 'completion-artifacts/v1/envelopes/other/sha256/x.pdf'
		};
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_key_mismatch'
		});
	});

	it('fails closed when the tampered object bytes hash to a different digest than recorded', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const original: Uint8Array = Uint8Array.from([1, 2, 3, 4]);
		const record = await publish(objects, original);
		const key: string = record.pdfObjectKey;
		objects.seed(key, Uint8Array.from([9, 9, 9, 9]), record.pdfSha256);
		store.record = record;
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_digest_mismatch'
		});
	});

	it('fails closed when object metadata reports a different key than requested', async () => {
		const store = new FakePdfStore();
		const record = await publish(new InMemoryObjectStore(), new Uint8Array(4));
		store.record = record;
		const objects: ObjectStore = {
			head: async (): Promise<ObjectMetadata> => ({
				key: 'wrong-key',
				contentType: 'application/pdf',
				size: 4,
				sha256: record.pdfSha256,
				version: null
			}),
			get: async (): Promise<null> => null,
			putImmutable: async (): Promise<never> => {
				throw new Error('unused');
			},
			delete: async (): Promise<void> => {},
			list: async () => ({ objects: [], truncated: false }),
			deleteMany: async (): Promise<void> => {}
		};
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_metadata_mismatch'
		});
	});

	it('fails closed when the readable stream is shorter than the attested size', async () => {
		const store = new FakePdfStore();
		const objects = new InMemoryObjectStore();
		const record = await publish(objects, Uint8Array.from([1, 2, 3, 4]));
		store.record = record;
		const shortStream: ObjectStore = {
			head: async (): Promise<ObjectMetadata> => ({
				key: record.pdfObjectKey,
				contentType: 'application/pdf',
				size: 4,
				sha256: record.pdfSha256,
				version: null
			}),
			get: async (): Promise<ReadableStream<Uint8Array>> =>
				new ReadableStream<Uint8Array>({
					start(controller): void {
						controller.enqueue(Uint8Array.from([1, 2]));
						controller.close();
					}
				}),
			putImmutable: async (): Promise<never> => {
				throw new Error('unused');
			},
			delete: async (): Promise<void> => {},
			list: async () => ({ objects: [], truncated: false }),
			deleteMany: async (): Promise<void> => {}
		};
		const reader = new CompletionPdfAttachmentReader(store, shortStream);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_size_mismatch'
		});
	});

	it('reads a PDF spanning multiple stream chunks and preserves exact bytes', async () => {
		const store = new FakePdfStore();
		const bytes: Uint8Array = new Uint8Array(200_000);
		for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
		const sha256: string = await sha256Hex(bytes);
		const key: string = completionArtifactObjectKey(ENVELOPE_ID, 'pdf', sha256);
		store.record = {
			envelopeId: ENVELOPE_ID,
			pdfObjectKey: key,
			pdfSha256: sha256,
			pdfByteSize: bytes.byteLength,
			pdfManifestObjectKey: completionArtifactObjectKey(ENVELOPE_ID, 'pdf-manifest', sha256),
			pdfManifestSha256: sha256,
			publishedAt: '2026-09-12T00:00:00.000Z'
		};
		const chunkSize = 16 * 1024;
		const objects: ObjectStore = {
			head: async (): Promise<ObjectMetadata> => ({
				key,
				contentType: 'application/pdf',
				size: bytes.byteLength,
				sha256,
				version: null
			}),
			get: async (): Promise<ReadableStream<Uint8Array>> =>
				new ReadableStream<Uint8Array>({
					start(controller): void {
						for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
							controller.enqueue(bytes.subarray(offset, offset + chunkSize));
						}
						controller.close();
					}
				}),
			putImmutable: async (): Promise<never> => {
				throw new Error('unused');
			},
			delete: async (): Promise<void> => {},
			list: async () => ({ objects: [], truncated: false }),
			deleteMany: async (): Promise<void> => {}
		};
		const reader = new CompletionPdfAttachmentReader(store, objects);

		const result = await reader.read(ENVELOPE_ID);
		expect(result.outcome).toBe('attached');
		if (result.outcome === 'attached') {
			expect(result.bytes).toEqual(bytes);
		}
	});

	it('treats a missing PDF record read as retryable', async () => {
		const store = new FakePdfStore();
		store.shouldThrow = true;
		const objects = new InMemoryObjectStore();
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'retryable_error',
			errorCode: 'completion_pdf_record_unavailable'
		});
	});

	it('treats a published record whose object is temporarily missing as retryable', async () => {
		const store = new FakePdfStore();
		const record = await publish(new InMemoryObjectStore(), Uint8Array.from([1, 2, 3, 4]));
		store.record = record;
		const objects = new InMemoryObjectStore();
		const reader = new CompletionPdfAttachmentReader(store, objects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'retryable_error',
			errorCode: 'completion_pdf_object_missing'
		});
	});

	it('treats an object storage head failure as retryable', async () => {
		const store = new FakePdfStore();
		const record = await publish(new InMemoryObjectStore(), Uint8Array.from([1, 2, 3, 4]));
		store.record = record;
		const failingObjects: ObjectStore = {
			head: async (): Promise<never> => {
				throw new Error('storage unavailable');
			},
			get: async (): Promise<null> => null,
			putImmutable: async (): Promise<never> => {
				throw new Error('unused');
			},
			delete: async (): Promise<void> => {},
			list: async () => ({ objects: [], truncated: false }),
			deleteMany: async (): Promise<void> => {}
		};
		const reader = new CompletionPdfAttachmentReader(store, failingObjects);

		await expect(reader.read(ENVELOPE_ID)).resolves.toEqual({
			outcome: 'retryable_error',
			errorCode: 'completion_pdf_storage_unavailable'
		});
	});
});
