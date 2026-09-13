import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
	draftArchiveKey,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { exportPinnedDocx } from './docx-export-service';

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
