import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { IsomorphicGitDraftRepository } from './isomorphic-git-repository';

const actor = { id: 'user_1', name: 'Yu Kimura', email: 'yu@example.test', type: 'user' as const };

describe('IsomorphicGitDraftRepository', () => {
	it('creates and continues one compressed Git history', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const first = await repository.commit(
			null,
			[{ path: 'documents/main.md', content: '# Agreement' }],
			'Create draft',
			actor
		);
		const second = await repository.commit(
			first.archive,
			[{ path: 'documents/main.md', content: '# Agreement\n\nRevised.' }],
			'Revise draft',
			actor
		);
		expect(first.commitSha).toMatch(/^[a-f0-9]{40}$/);
		expect(second.commitSha).not.toBe(first.commitSha);
		expect(second.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
		await expect(repository.read(second.archive, second.commitSha)).resolves.toEqual([
			{ path: 'documents/main.md', content: '# Agreement\n\nRevised.\n' }
		]);
		await expect(repository.read(second.archive, first.commitSha)).rejects.toThrow(
			/HEAD does not match/
		);
	});

	it('rejects binary and traversal paths', async () => {
		const repository = new IsomorphicGitDraftRepository();
		await expect(
			repository.commit(
				null,
				[{ path: 'documents/source.docx' as `documents/${string}.md`, content: 'x' }],
				'Bad',
				actor
			)
		).rejects.toThrow(/Markdown/);
	});

	it('rejects highly compressed archives before allocating their decoded payload', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const oversizedDecodedPayload: Uint8Array = new Uint8Array(16 * 1024 * 1024 + 1).fill(0x61);
		const archive: Uint8Array = gzipSync(oversizedDecodedPayload, { level: 9, mtime: 0 });

		expect(archive.byteLength).toBeLessThan(12 * 1024 * 1024);
		await expect(repository.read(archive, '0'.repeat(40))).rejects.toThrow(/decoded size limit/);
	});

	it('reads commit message and revision snapshot from verified Git archive', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const version = await repository.commit(
			null,
			[{ path: 'documents/contract.md', content: '# Terms' }],
			'Add contractual terms',
			actor
		);

		const message = await repository.readCommitMessage(version.archive, version.commitSha);
		expect(message).toBe('Add contractual terms');

		const snapshot = await repository.readRevisionSnapshot(version.archive, version.commitSha);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.commitSha).toBe(version.commitSha);
		expect(snapshot?.message).toBe('Add contractual terms');
		expect(snapshot?.documents).toEqual([{ path: 'documents/contract.md', content: '# Terms\n' }]);
	});
});
