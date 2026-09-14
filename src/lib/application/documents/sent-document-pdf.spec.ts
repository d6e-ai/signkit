import { describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type { DraftActor, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import {
	draftArchiveKey,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import {
	MAX_SENT_PDF_DOCUMENTS,
	parseSentPdfObjectKey,
	SentDocumentPdfError,
	SentDocumentPdfService,
	sentPdfObjectKey,
	renderRevisionPdf
} from './sent-document-pdf';

const ORGANIZATION_ID = '01900000-0000-7000-8000-000000000002';
const ENVELOPE_ID = '01900000-0000-7000-8000-000000000001';

const actor: DraftActor = {
	id: '01900000-0000-7000-8000-000000000003',
	name: 'Author',
	email: 'author@example.com',
	type: 'user'
};

async function pinnedRevision(
	objects: ObjectStore,
	repository: DraftRepository,
	documents: readonly { path: `documents/${string}.md`; content: string }[]
): Promise<ImmutableDraftRevision> {
	const version: DraftVersion = await repository.commit(null, documents, 'seed', actor);
	const archiveKey: string = draftArchiveKey(ORGANIZATION_ID, ENVELOPE_ID, version.archiveSha256);
	await objects.putImmutable(archiveKey, {
		contentType: 'application/vnd.signkit.git-archive+gzip',
		body: version.archive,
		sha256: version.archiveSha256
	});
	return {
		organizationId: ORGANIZATION_ID,
		envelopeId: ENVELOPE_ID,
		commitSha: version.commitSha,
		archiveKey,
		archiveSha256: version.archiveSha256
	};
}

describe('sentPdfObjectKey', () => {
	it('is content-addressed and tenant-scoped, and round-trips', () => {
		const sha256: string = 'a'.repeat(64);
		const key: string = sentPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, sha256);
		expect(key).toBe(
			`sent-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${sha256}.pdf`
		);
		expect(parseSentPdfObjectKey(key)).toEqual({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			sha256
		});
	});

	it('escapes scope segments so no identifier can climb out of its prefix', () => {
		const key: string = sentPdfObjectKey('../escape', 'env/../other', 'b'.repeat(64));
		expect(key).not.toContain('..');
		expect(key.split('/')).toHaveLength(8);
		expect(parseSentPdfObjectKey(key)).toEqual({
			organizationId: '../escape',
			envelopeId: 'env/../other',
			sha256: 'b'.repeat(64)
		});
	});

	it('rejects a digest that is not a SHA-256 hex string', () => {
		expect(() => sentPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, 'nope')).toThrow(
			SentDocumentPdfError
		);
		expect(parseSentPdfObjectKey('sent-documents/v1/anything.pdf')).toBeNull();
	});
});

describe('renderRevisionPdf', () => {
	it('refuses a revision with no documents', () => {
		expect(() => renderRevisionPdf([])).toThrow(SentDocumentPdfError);
	});

	it('refuses more documents than the bound allows', () => {
		const documents = Array.from(
			{ length: MAX_SENT_PDF_DOCUMENTS + 1 },
			(_unused, index: number) => ({
				path: `documents/doc-${index}.md` as `documents/${string}.md`,
				content: '# Doc\n'
			})
		);
		expect(() => renderRevisionPdf(documents)).toThrow(SentDocumentPdfError);
	});

	it('refuses a revision that exceeds the total Markdown budget', () => {
		expect(() =>
			renderRevisionPdf([
				{ path: 'documents/a.md', content: 'x'.repeat(600 * 1024) },
				{ path: 'documents/b.md', content: 'x'.repeat(600 * 1024) }
			])
		).toThrow(SentDocumentPdfError);
	});
});

describe('SentDocumentPdfService', () => {
	it('writes an immutable, content-addressed object and returns a pinned pointer', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const revision = await pinnedRevision(objects, repository, [
			{ path: 'documents/agreement.md', content: '# 契約書\n\n本文です。\n' },
			{ path: 'documents/appendix.md', content: '# Appendix\n\nSchedule.\n' }
		]);
		const service: SentDocumentPdfService = new SentDocumentPdfService(objects, repository);

		const artifact = await service.publish(revision);

		expect(artifact.objectKey).toBe(
			sentPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, artifact.sha256)
		);
		expect(artifact.byteSize).toBeGreaterThan(0);
		expect(artifact.pageCount).toBeGreaterThanOrEqual(2);
		expect(artifact.documents.map((entry) => entry.path)).toEqual([
			'documents/agreement.md',
			'documents/appendix.md'
		]);
		const stored: ObjectMetadata | null = await objects.head(artifact.objectKey);
		expect(stored).toMatchObject({ sha256: artifact.sha256, size: artifact.byteSize });
	});

	it('publishes the same key twice without failing, because the bytes are identical', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const revision = await pinnedRevision(objects, repository, [
			{ path: 'documents/agreement.md', content: '# Agreement\n' }
		]);
		const service: SentDocumentPdfService = new SentDocumentPdfService(objects, repository);

		const first = await service.publish(revision);
		const second = await service.publish(revision);
		expect(second).toEqual(first);
	});

	it('fails closed when a failed write cannot be proven to have landed correctly', async () => {
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const revision = await pinnedRevision(objects, repository, [
			{ path: 'documents/agreement.md', content: '# Agreement\n' }
		]);
		class HostileStore extends InMemoryObjectStore {
			override async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
				if (key.startsWith('sent-documents/')) throw new Error('provider rejected the write');
				return super.putImmutable(key, object);
			}
			override async head(key: string): Promise<ObjectMetadata | null> {
				if (key.startsWith('sent-documents/')) {
					// A resurrected object with the right key but the wrong bytes.
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
		const hostile: HostileStore = new HostileStore();
		const stream: ReadableStream<Uint8Array> | null = await objects.get(revision.archiveKey);
		const archive: Uint8Array = new Uint8Array(await new Response(stream).arrayBuffer());
		await hostile.putImmutable(revision.archiveKey, {
			contentType: 'application/vnd.signkit.git-archive+gzip',
			body: archive,
			sha256: revision.archiveSha256
		});

		await expect(new SentDocumentPdfService(hostile, repository).publish(revision)).rejects.toThrow(
			'provider rejected the write'
		);
	});

	it('renders without storing anything when only the geometry is needed', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const revision = await pinnedRevision(objects, repository, [
			{ path: 'documents/agreement.md', content: '# Agreement\n' }
		]);
		const before = (await objects.list({ prefix: 'sent-documents/' })).objects.length;

		const rendered = await new SentDocumentPdfService(objects, repository).render(revision);

		expect(rendered.bytes.byteLength).toBe(rendered.byteSize);
		expect((await objects.list({ prefix: 'sent-documents/' })).objects.length).toBe(before);
	});
});
