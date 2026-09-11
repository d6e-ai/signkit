import { describe, expect, it } from 'vitest';
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
});
