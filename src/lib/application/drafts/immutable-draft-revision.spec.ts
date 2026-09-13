import { describe, expect, it } from 'vitest';
import type { ListObjectsResult, ObjectMetadata } from '$lib/ports/object-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import {
	DraftIntegrityError,
	draftArchiveKey,
	readImmutableDraftRevision
} from './draft-persistence';

/**
 * Guards that `readImmutableDraftRevision` only ever reads via `get`: every
 * other method throws instead of quietly succeeding, so a regression that
 * starts calling head/put/delete/list on the store fails loudly here.
 */
class ReadOnlyObjectStore extends InMemoryObjectStore {
	override async head(): Promise<ObjectMetadata | null> {
		throw new Error('not implemented');
	}

	override async putImmutable(): Promise<ObjectMetadata> {
		throw new Error('not implemented');
	}

	override async delete(): Promise<void> {
		throw new Error('not implemented');
	}

	override async list(): Promise<ListObjectsResult> {
		throw new Error('not implemented');
	}

	override async deleteMany(): Promise<void> {
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
		const objects = new ReadOnlyObjectStore();
		objects.seed(archiveKey, version.archive);

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
		const objects = new ReadOnlyObjectStore();
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
		expect(objects.getCalls).toBe(0);
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
		const corruptedStore = new ReadOnlyObjectStore();
		corruptedStore.seed(archiveKey, corrupted);
		const mismatchedHeadStore = new ReadOnlyObjectStore();
		mismatchedHeadStore.seed(archiveKey, version.archive);

		await expect(
			readImmutableDraftRevision(revision, corruptedStore, repository)
		).rejects.toBeInstanceOf(DraftIntegrityError);
		await expect(
			readImmutableDraftRevision(
				{ ...revision, commitSha: 'c'.repeat(40) },
				mismatchedHeadStore,
				repository
			)
		).rejects.toBeInstanceOf(DraftIntegrityError);
	});
});
