import { describe, expect, it, vi } from 'vitest';
import { sentPdfObjectKey } from '$lib/application/documents/sent-document-pdf';
import type { EnvelopeSentPdfStore, SentPdfPointer } from '$lib/ports/envelope-sent-pdf-store';
import type { EnvelopeSentDocumentStore } from '$lib/ports/envelope-sent-document-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { ObjectStore } from '$lib/ports/object-store';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { RecipientAccessApplicationPort } from './recipient-access';
import { RecipientSentPdfService } from './recipient-sent-pdf';

const TOKEN: string = `skr1_${'A'.repeat(43)}`;
const ORGANIZATION_ID = 'org-secret';
const ENVELOPE_ID = 'env-1';
const PDF_BYTES: Uint8Array = new TextEncoder().encode('%PDF-1.7\nagreement bytes\n%%EOF\n');

const context: RecipientSigningContext = {
	organizationId: ORGANIZATION_ID,
	envelopeId: ENVELOPE_ID,
	recipientId: 'recipient-1',
	recipientName: 'Private Recipient',
	recipientLocale: 'en',
	recipientRole: 'signer',
	recipientStatus: 'pending',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'sent',
	expiresAt: '2026-09-12T00:00:00.000Z',
	sentRevision: {
		commitSha: 'a'.repeat(40),
		archiveKey: 'private/archive.git.gz',
		archiveSha256: 'b'.repeat(64)
	}
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

async function pointerFor(bytes: Uint8Array = PDF_BYTES): Promise<SentPdfPointer> {
	const sha256: string = await sha256Hex(bytes);
	return {
		organizationId: ORGANIZATION_ID,
		envelopeId: ENVELOPE_ID,
		commitSha: context.sentRevision.commitSha,
		objectKey: sentPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, sha256),
		sha256,
		byteSize: bytes.byteLength,
		pageCount: 1,
		pageWidth: 595.28,
		pageHeight: 841.89,
		documents: [{ path: 'documents/a.md', title: 'a', firstPage: 1, lastPage: 1 }],
		createdAt: '2026-09-11T00:00:00.000Z'
	};
}

function access(...results: readonly (RecipientSigningContext | null)[]): {
	port: RecipientAccessApplicationPort;
	resolve: ReturnType<typeof vi.fn>;
} {
	const resolve = vi.fn();
	for (const result of results) resolve.mockResolvedValueOnce(result);
	return { port: { resolve }, resolve };
}

function store(...results: readonly (SentPdfPointer | null)[]): EnvelopeSentPdfStore {
	const findSentPdf = vi.fn();
	for (const result of results) findSentPdf.mockResolvedValueOnce(result);
	return { findSentPdf };
}

function emptySentDocuments(): EnvelopeSentDocumentStore {
	return {
		findSet: vi.fn(async () => null),
		findDocument: vi.fn(async () => null)
	};
}

function sentPdfService(
	access: RecipientAccessApplicationPort,
	pointers: EnvelopeSentPdfStore,
	objects: ObjectStore
): RecipientSentPdfService {
	return new RecipientSentPdfService(access, emptySentDocuments(), pointers, objects);
}

async function objectsWith(pointer: SentPdfPointer, bytes: Uint8Array): Promise<ObjectStore> {
	const objects: InMemoryObjectStore = new InMemoryObjectStore();
	await objects.putImmutable(pointer.objectKey, {
		contentType: 'application/pdf',
		body: bytes,
		sha256: await sha256Hex(bytes)
	});
	return objects;
}

describe('RecipientSentPdfService', () => {
	it('serves the pinned bytes after revalidating access and the pointer on both sides of the read', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		const objects: ObjectStore = await objectsWith(pointer, PDF_BYTES);
		const { port, resolve } = access(context, context);
		const pointers: EnvelopeSentPdfStore = store(pointer, pointer);

		const result = await sentPdfService(port, pointers, objects).read(TOKEN, ENVELOPE_ID);

		expect(result).toEqual({
			outcome: 'ok',
			bytes: PDF_BYTES,
			sha256: pointer.sha256,
			byteSize: PDF_BYTES.byteLength
		});
		// Twice each: a capability can be revoked while object storage is slow.
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(pointers.findSentPdf).toHaveBeenCalledTimes(2);
		expect(pointers.findSentPdf).toHaveBeenCalledWith(
			ORGANIZATION_ID,
			ENVELOPE_ID,
			context.sentRevision.commitSha
		);
	});

	it('reports not_found for inactive access without touching object storage', async () => {
		const objects: ObjectStore = new InMemoryObjectStore();
		const get = vi.spyOn(objects, 'get');
		const pointers: EnvelopeSentPdfStore = store();

		await expect(
			sentPdfService(access(null).port, pointers, objects).read(TOKEN, ENVELOPE_ID)
		).resolves.toEqual({ outcome: 'not_found' });
		expect(pointers.findSentPdf).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});

	it('reports not_found when the path envelope ID does not match the capability', async () => {
		const objects: ObjectStore = new InMemoryObjectStore();
		const get = vi.spyOn(objects, 'get');
		const pointers: EnvelopeSentPdfStore = store();

		await expect(
			sentPdfService(access(context).port, pointers, objects).read(TOKEN, 'other-envelope')
		).resolves.toEqual({ outcome: 'not_found' });
		expect(pointers.findSentPdf).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});

	it('reports not_found when access is revoked during the object read', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		const objects: ObjectStore = await objectsWith(pointer, PDF_BYTES);
		await expect(
			sentPdfService(access(context, null).port, store(pointer, pointer), objects).read(
				TOKEN,
				ENVELOPE_ID
			)
		).resolves.toEqual({ outcome: 'not_found' });
	});

	it('is unavailable when no rendering has been published for the sent commit', async () => {
		const objects: ObjectStore = new InMemoryObjectStore();
		await expect(
			sentPdfService(access(context, context).port, store(null), objects).read(TOKEN, ENVELOPE_ID)
		).resolves.toEqual({ outcome: 'unavailable' });
	});

	it('is unavailable when the object is missing', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		await expect(
			sentPdfService(
				access(context, context).port,
				store(pointer, pointer),
				new InMemoryObjectStore()
			).read(TOKEN, ENVELOPE_ID)
		).resolves.toEqual({ outcome: 'unavailable' });
	});

	it('is unavailable when the stored bytes do not match the pinned digest', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		const tampered: Uint8Array = new TextEncoder().encode('%PDF-1.7\nsomething else\n%%EOF\n');
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		await objects.putImmutable(pointer.objectKey, {
			contentType: 'application/pdf',
			body: tampered,
			sha256: await sha256Hex(tampered)
		});

		await expect(
			sentPdfService(access(context, context).port, store(pointer, pointer), objects).read(
				TOKEN,
				ENVELOPE_ID
			)
		).resolves.toEqual({ outcome: 'unavailable' });
	});

	it('is unavailable when the object is longer than the pinned size', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		const longer: Uint8Array = new Uint8Array(pointer.byteSize + 64);
		longer.set(PDF_BYTES);
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		await objects.putImmutable(pointer.objectKey, {
			contentType: 'application/pdf',
			body: longer,
			sha256: await sha256Hex(longer)
		});

		await expect(
			sentPdfService(access(context, context).port, store(pointer, pointer), objects).read(
				TOKEN,
				ENVELOPE_ID
			)
		).resolves.toEqual({ outcome: 'unavailable' });
	});

	it('is unavailable when the stored key is not the one the digest and scope imply', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		const crossTenant: SentPdfPointer = {
			...pointer,
			objectKey: sentPdfObjectKey('other-org', ENVELOPE_ID, pointer.sha256)
		};
		const objects: ObjectStore = await objectsWith(crossTenant, PDF_BYTES);

		await expect(
			sentPdfService(access(context, context).port, store(crossTenant, crossTenant), objects).read(
				TOKEN,
				ENVELOPE_ID
			)
		).resolves.toEqual({ outcome: 'unavailable' });
	});

	it('is unavailable when the pointer is re-published under a different digest mid-read', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		const objects: ObjectStore = await objectsWith(pointer, PDF_BYTES);
		const replaced: SentPdfPointer = {
			...pointer,
			sha256: 'c'.repeat(64),
			objectKey: sentPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, 'c'.repeat(64))
		};

		await expect(
			sentPdfService(access(context, context).port, store(pointer, replaced), objects).read(
				TOKEN,
				ENVELOPE_ID
			)
		).resolves.toEqual({ outcome: 'unavailable' });
	});

	it('is unavailable when the envelope is re-pinned to another commit mid-read', async () => {
		const pointer: SentPdfPointer = await pointerFor();
		const objects: ObjectStore = await objectsWith(pointer, PDF_BYTES);
		const repinned: RecipientSigningContext = {
			...context,
			sentRevision: { ...context.sentRevision, commitSha: 'd'.repeat(40) }
		};

		await expect(
			sentPdfService(access(context, repinned).port, store(pointer, pointer), objects).read(
				TOKEN,
				ENVELOPE_ID
			)
		).resolves.toEqual({ outcome: 'unavailable' });
	});
});
