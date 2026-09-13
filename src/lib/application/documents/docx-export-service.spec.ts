import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
	draftArchiveKey,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import type { Envelope } from '$lib/domain/envelope';
import { exportEnvelopeDocx, exportPinnedDocx } from './docx-export-service';

const organizationId = 'org-1';
const envelopeId = '01900000-0000-7000-8000-000000000001';
const commitSha = '0123456789abcdef0123456789abcdef01234567';

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

class MemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, Uint8Array>();

	seed(key: string, body: Uint8Array): void {
		this.objects.set(key, body);
	}

	async head(): Promise<ObjectMetadata | null> {
		return null;
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		const body = this.objects.get(key);
		if (body === undefined) return null;
		return new ReadableStream<Uint8Array>({
			start(controller): void {
				controller.enqueue(body);
				controller.close();
			}
		});
	}

	async putImmutable(): Promise<ObjectMetadata> {
		throw new Error('Unexpected object write');
	}

	async delete(): Promise<void> {}

	async list(): Promise<Awaited<ReturnType<ObjectStore['list']>>> {
		throw new Error('unused');
	}

	async deleteMany(): Promise<void> {
		throw new Error('unused');
	}
}

class FixedDraftRepository implements DraftRepository {
	constructor(private readonly documents: readonly DraftDocument[]) {}

	async read(): Promise<readonly DraftDocument[]> {
		return this.documents;
	}

	async commit(): Promise<DraftVersion> {
		throw new Error('Unexpected repository commit');
	}
}

describe('exportPinnedDocx', () => {
	it('renders the pinned revision’s documents into a DOCX package', async () => {
		const archive = new TextEncoder().encode('archive-bytes');
		const archiveSha256 = sha256Hex(archive);
		const archiveKey = draftArchiveKey(organizationId, envelopeId, archiveSha256);
		const objects = new MemoryObjectStore();
		objects.seed(archiveKey, archive);
		const repository = new FixedDraftRepository([
			{ path: 'documents/agreement.md', content: '# Agreement\n\nPinned content.\n' }
		]);
		const revision: ImmutableDraftRevision = {
			organizationId,
			envelopeId,
			commitSha,
			archiveKey,
			archiveSha256
		};

		const docx = await exportPinnedDocx(revision, objects, repository);

		const files = unzipSync(docx);
		const documentXml = new TextDecoder().decode(files['word/document.xml']);
		expect(documentXml).toContain('Agreement');
		expect(documentXml).toContain('Pinned content.');
		const core = new TextDecoder().decode(files['docProps/core.xml']);
		expect(core).toContain(commitSha);
	});
});

describe('exportEnvelopeDocx', () => {
	const envelope: Envelope = {
		id: envelopeId,
		organizationId,
		title: 'Agreement',
		status: 'ready',
		repositoryGeneration: 1,
		repositoryHead: commitSha,
		repositoryArchiveKey: draftArchiveKey(
			organizationId,
			envelopeId,
			sha256Hex(new TextEncoder().encode('archive-bytes'))
		),
		repositoryArchiveSha256: sha256Hex(new TextEncoder().encode('archive-bytes')),
		sentCommitSha: null,
		fieldGeneration: 0,
		createdAt: '2026-09-11T00:00:00.000Z',
		updatedAt: '2026-09-11T00:00:00.000Z'
	};

	it('exports the envelope’s current trusted locator without writing objects', async () => {
		const archive = new TextEncoder().encode('archive-bytes');
		const objects = new MemoryObjectStore();
		objects.seed(envelope.repositoryArchiveKey as string, archive);
		const repository = new FixedDraftRepository([
			{ path: 'documents/agreement.md', content: '# Agreement\n\nPinned content.\n' }
		]);

		const result = await exportEnvelopeDocx(
			organizationId,
			envelopeId,
			{ findForOrganization: async () => envelope },
			objects,
			repository
		);

		expect(result).toMatchObject({ outcome: 'exported', commitSha });
		if (result.outcome !== 'exported') return;
		const files = unzipSync(result.bytes);
		expect(new TextDecoder().decode(files['word/document.xml'])).toContain('Pinned content.');
	});

	it('reports empty_draft when no Git pin exists', async () => {
		const result = await exportEnvelopeDocx(
			organizationId,
			envelopeId,
			{
				findForOrganization: async () => ({
					...envelope,
					repositoryHead: null,
					repositoryArchiveKey: null,
					repositoryArchiveSha256: null
				})
			},
			new MemoryObjectStore(),
			new FixedDraftRepository([])
		);
		expect(result).toEqual({ outcome: 'empty_draft' });
	});

	it('reports not_found for an unknown envelope', async () => {
		const result = await exportEnvelopeDocx(
			organizationId,
			envelopeId,
			{ findForOrganization: async () => null },
			new MemoryObjectStore(),
			new FixedDraftRepository([])
		);
		expect(result).toEqual({ outcome: 'not_found' });
	});
});
