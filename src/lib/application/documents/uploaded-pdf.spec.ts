import { describe, expect, it, vi } from 'vitest';
import {
	DraftGenerationConflictError,
	type CommitDraftResult
} from '$lib/application/drafts/draft-persistence';
import { renderAgreementPdf } from '$lib/adapters/pdf/agreement-pdf';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { ObjectMetadata, PutObject } from '$lib/ports/object-store';
import type {
	EnvelopeUploadedDocumentRecord,
	EnvelopeUploadedDocumentStore,
	InsertUploadedDocumentResult
} from '$lib/ports/envelope-uploaded-document-store';
import {
	MAX_UPLOADED_PDF_BYTES,
	parseUploadedPdfObjectKey,
	uploadedPdfObjectKey,
	UploadedPdfError
} from './uploaded-pdf';
import { sha256Hex } from './sent-document-pdf';
import { UploadedPdfUploadError, UploadedPdfUploadService } from './uploaded-pdf-upload-service';

const ORGANIZATION_ID = '01900000-0000-7000-8000-000000000002';
const ENVELOPE_ID = '01900000-0000-7000-8000-000000000001';

describe('uploadedPdfObjectKey', () => {
	it('is content-addressed and tenant-scoped, and round-trips', () => {
		const sha256: string = 'a'.repeat(64);
		const key: string = uploadedPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, sha256);
		expect(key).toBe(
			`uploaded-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${sha256}.pdf`
		);
		expect(parseUploadedPdfObjectKey(key)).toEqual({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			sha256
		});
	});

	it('escapes scope segments so no identifier can climb out of its prefix', () => {
		const key: string = uploadedPdfObjectKey('../escape', 'env/../other', 'b'.repeat(64));
		expect(key).not.toContain('..');
		expect(parseUploadedPdfObjectKey(key)).toEqual({
			organizationId: '../escape',
			envelopeId: 'env/../other',
			sha256: 'b'.repeat(64)
		});
	});

	it('rejects a digest that is not a SHA-256 hex string', () => {
		expect(() => uploadedPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, 'nope')).toThrow(
			UploadedPdfError
		);
		expect(parseUploadedPdfObjectKey('uploaded-documents/v1/anything.pdf')).toBeNull();
	});

	it('exposes the 20 MiB upload bound used by the HTTP handler', () => {
		expect(MAX_UPLOADED_PDF_BYTES).toBe(20 * 1024 * 1024);
	});
});

const actor = {
	id: '01900000-0000-7000-8000-000000000003',
	name: 'Author',
	email: 'author@example.com',
	type: 'user' as const
};

function samplePdfBytes(): Uint8Array {
	return renderAgreementPdf([
		{ title: 'Agreement', nodes: renderRecipientMarkdown('# Agreement\n\nHello.\n').nodes }
	]).bytes;
}

function committed(): CommitDraftResult {
	return {
		outcome: 'committed',
		revision: {
			generation: 1,
			commitSha: 'a'.repeat(40),
			archiveKey: 'archive-key',
			archiveSha256: 'b'.repeat(64),
			updatedAt: '2026-09-11T00:00:00.000Z',
			auditEventId: '01900000-0000-7000-8000-000000000099'
		}
	};
}

class MemoryUploadedDocuments implements EnvelopeUploadedDocumentStore {
	inserts: EnvelopeUploadedDocumentRecord[] = [];
	nextInsert: InsertUploadedDocumentResult = 'inserted';

	async insert(record: EnvelopeUploadedDocumentRecord): Promise<InsertUploadedDocumentResult> {
		if (this.nextInsert === 'inserted' || this.nextInsert === 'duplicate') {
			this.inserts.push(record);
		}
		return this.nextInsert;
	}

	async find(
		_organizationId: string,
		_envelopeId: string,
		sha256: string
	): Promise<EnvelopeUploadedDocumentRecord | null> {
		return this.inserts.find((record) => record.sha256 === sha256) ?? null;
	}
}

describe('UploadedPdfUploadService', () => {
	it('stores bytes immutably then appends a pdf leaf', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committed());
		const objects = new InMemoryObjectStore();
		const uploaded = new MemoryUploadedDocuments();
		const bytes = samplePdfBytes();
		const digest = await sha256Hex(bytes);

		await new UploadedPdfUploadService({ commit }, objects, uploaded).upload({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			expectedGeneration: 0,
			actor,
			idempotencyKey: 'upload-1',
			bytes,
			filename: 'schedule.pdf',
			title: 'Schedule A'
		});

		expect(uploaded.inserts).toHaveLength(1);
		expect(uploaded.inserts[0]).toMatchObject({
			sha256: digest,
			objectKey: uploadedPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, digest),
			byteSize: bytes.byteLength
		});
		expect(commit).toHaveBeenCalledWith(
			expect.objectContaining({
				edits: [],
				documentSet: expect.objectContaining({
					op: 'appendPdf',
					title: 'Schedule A',
					sha256: digest,
					byteSize: bytes.byteLength
				})
			})
		);
	});

	it('replays the same digest without writing a second object', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => ({
			...committed(),
			outcome: 'replayed'
		}));
		const objects = new InMemoryObjectStore();
		const uploaded = new MemoryUploadedDocuments();
		uploaded.nextInsert = 'duplicate';
		const bytes = samplePdfBytes();
		const service = new UploadedPdfUploadService({ commit }, objects, uploaded);

		await service.upload({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			expectedGeneration: 0,
			actor,
			idempotencyKey: 'upload-1',
			bytes,
			title: 'Schedule A'
		});
		await service.upload({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			expectedGeneration: 0,
			actor,
			idempotencyKey: 'upload-1',
			bytes,
			title: 'Schedule A'
		});

		const listed = await objects.list({
			prefix: `uploaded-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/`
		});
		expect(listed.objects).toHaveLength(1);
		expect(commit).toHaveBeenCalledTimes(2);
	});

	it('propagates a generation conflict from persistence', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => {
			throw new DraftGenerationConflictError(1);
		});
		await expect(
			new UploadedPdfUploadService(
				{ commit },
				new InMemoryObjectStore(),
				new MemoryUploadedDocuments()
			).upload({
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				expectedGeneration: 0,
				actor,
				idempotencyKey: 'upload-stale',
				bytes: samplePdfBytes()
			})
		).rejects.toBeInstanceOf(DraftGenerationConflictError);
	});

	it('refuses an envelope that has reached the uploaded digest cap', async () => {
		const uploaded = new MemoryUploadedDocuments();
		uploaded.nextInsert = 'cap_exceeded';
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committed());
		await expect(
			new UploadedPdfUploadService({ commit }, new InMemoryObjectStore(), uploaded).upload({
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				expectedGeneration: 0,
				actor,
				idempotencyKey: 'upload-cap',
				bytes: samplePdfBytes()
			})
		).rejects.toMatchObject({ reason: 'cap_exceeded' });
		expect(commit).not.toHaveBeenCalled();
	});

	it('recovers a putImmutable failure when the digest already landed', async () => {
		const bytes = samplePdfBytes();
		const digest = await sha256Hex(bytes);
		const key = uploadedPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, digest);
		class RecoveringStore extends InMemoryObjectStore {
			override async putImmutable(objectKey: string, object: PutObject): Promise<ObjectMetadata> {
				if (objectKey === key) {
					await super.putImmutable(objectKey, object);
					throw new Error('provider rejected the write');
				}
				return super.putImmutable(objectKey, object);
			}
		}
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committed());
		await expect(
			new UploadedPdfUploadService(
				{ commit },
				new RecoveringStore(),
				new MemoryUploadedDocuments()
			).upload({
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				expectedGeneration: 0,
				actor,
				idempotencyKey: 'upload-recover',
				bytes
			})
		).resolves.toMatchObject({ outcome: 'committed' });
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it('rethrows a putImmutable failure when the stored digest does not match', async () => {
		class HostileStore extends InMemoryObjectStore {
			override async putImmutable(): Promise<ObjectMetadata> {
				throw new Error('provider rejected the write');
			}
			override async head(key: string): Promise<ObjectMetadata | null> {
				if (key.startsWith('uploaded-documents/')) {
					return {
						key,
						contentType: 'application/pdf',
						size: 7,
						sha256: 'c'.repeat(64),
						version: null
					};
				}
				return super.head(key);
			}
		}
		await expect(
			new UploadedPdfUploadService(
				{ commit: async () => committed() },
				new HostileStore(),
				new MemoryUploadedDocuments()
			).upload({
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				expectedGeneration: 0,
				actor,
				idempotencyKey: 'upload-mismatch',
				bytes: samplePdfBytes()
			})
		).rejects.toThrow('provider rejected the write');
	});

	it('rejects an empty or oversized upload before touching storage', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committed());
		const objects = new InMemoryObjectStore();
		const uploaded = new MemoryUploadedDocuments();
		const service = new UploadedPdfUploadService({ commit }, objects, uploaded);
		await expect(
			service.upload({
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				expectedGeneration: 0,
				actor,
				idempotencyKey: 'empty',
				bytes: new Uint8Array()
			})
		).rejects.toBeInstanceOf(UploadedPdfUploadError);
		await expect(
			service.upload({
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				expectedGeneration: 0,
				actor,
				idempotencyKey: 'huge',
				bytes: new Uint8Array(MAX_UPLOADED_PDF_BYTES + 1)
			})
		).rejects.toBeInstanceOf(UploadedPdfUploadError);
		expect(commit).not.toHaveBeenCalled();
		expect(uploaded.inserts).toHaveLength(0);
	});
});
