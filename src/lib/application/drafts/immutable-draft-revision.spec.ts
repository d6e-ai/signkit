import { describe, expect, it, vi } from 'vitest';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import {
	DraftIntegrityError,
	draftArchiveKey,
	readImmutableDraftRevision
} from './draft-persistence';

class ReadOnlyObjectStore implements ObjectStore {
	readonly get = vi.fn(async (): Promise<ReadableStream<Uint8Array> | null> =>
		this.body === null
			? null
			: new ReadableStream<Uint8Array>({
					start: (controller): void => {
						controller.enqueue(this.body as Uint8Array);
						controller.close();
					}
				})
	);

	constructor(readonly body: Uint8Array | null) {}

	async head(): Promise<ObjectMetadata | null> {
		throw new Error('not implemented');
	}

	async putImmutable(): Promise<ObjectMetadata> {
		throw new Error('not implemented');
	}

	async delete(): Promise<void> {
		throw new Error('not implemented');
	}
}

describe('readImmutableDraftRevision', () => {
	it('verifies the scoped key, archive digest, Git head, and tracked Markdown', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const version = await repository.commit(
			null,
			[{ path: 'documents/agreement.md', content: '# Agreement' }],
			'Initial agreement',
			{ id: 'user-1', name: 'User', email: 'user@example.com', type: 'user' }
		);
		const archiveKey: string = draftArchiveKey('org-1', 'env-1', version.archiveSha256);
		const objects = new ReadOnlyObjectStore(version.archive);

		await expect(
			readImmutableDraftRevision(
				{
					organizationId: 'org-1',
					envelopeId: 'env-1',
					commitSha: version.commitSha,
					archiveKey,
					archiveSha256: version.archiveSha256
				},
				objects,
				repository
			)
		).resolves.toEqual([{ path: 'documents/agreement.md', content: '# Agreement\n' }]);
	});

	it('rejects an unscoped key before reading object storage', async () => {
		const objects = new ReadOnlyObjectStore(new Uint8Array());
		await expect(
			readImmutableDraftRevision(
				{
					organizationId: 'org-1',
					envelopeId: 'env-1',
					commitSha: 'a'.repeat(40),
					archiveKey: 'other/archive.git.gz',
					archiveSha256: 'b'.repeat(64)
				},
				objects,
				new IsomorphicGitDraftRepository()
			)
		).rejects.toBeInstanceOf(DraftIntegrityError);
		expect(objects.get).not.toHaveBeenCalled();
	});

	it('rejects archive digest and Git head mismatches', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const version = await repository.commit(
			null,
			[{ path: 'documents/agreement.md', content: '# Agreement' }],
			'Initial agreement',
			{ id: 'user-1', name: 'User', email: 'user@example.com', type: 'user' }
		);
		const archiveKey: string = draftArchiveKey('org-1', 'env-1', version.archiveSha256);
		const revision = {
			organizationId: 'org-1',
			envelopeId: 'env-1',
			commitSha: version.commitSha,
			archiveKey,
			archiveSha256: version.archiveSha256
		};
		const corrupted: Uint8Array = Uint8Array.from(version.archive);
		corrupted[0] ^= 1;

		await expect(
			readImmutableDraftRevision(revision, new ReadOnlyObjectStore(corrupted), repository)
		).rejects.toBeInstanceOf(DraftIntegrityError);
		await expect(
			readImmutableDraftRevision(
				{ ...revision, commitSha: 'c'.repeat(40) },
				new ReadOnlyObjectStore(version.archive),
				repository
			)
		).rejects.toBeInstanceOf(DraftIntegrityError);
	});
});
