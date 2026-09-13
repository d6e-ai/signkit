import { describe, expect, it, vi } from 'vitest';
import type {
	CommitDraftInput,
	CommitDraftResult,
	DraftPersistenceService
} from '$lib/application/drafts/draft-persistence';
import { exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';
import { DocxImportError } from '$lib/adapters/documents/docx-import';
import { DocxImportService } from './docx-import-service';

const actor = { id: 'user-1', name: 'Alice', email: 'alice@example.com', type: 'user' as const };

function fakeDrafts(): { commit: ReturnType<typeof vi.fn>; calls: CommitDraftInput[] } {
	const calls: CommitDraftInput[] = [];
	const commit = vi.fn(async (input: CommitDraftInput): Promise<CommitDraftResult> => {
		calls.push(input);
		return {
			outcome: 'committed',
			revision: {
				generation: input.expectedGeneration + 1,
				commitSha: 'a'.repeat(40),
				archiveKey: 'archive-key',
				archiveSha256: 'b'.repeat(64),
				updatedAt: '2026-09-11T00:00:00.000Z',
				auditEventId: '01900000-0000-7000-8000-000000000099'
			}
		};
	});
	return { commit, calls };
}

describe('DocxImportService', () => {
	it('imports a DOCX upload as normalized Markdown and commits it through the existing draft boundary', async () => {
		const docx = exportMarkdownToDocx({
			commitSha: 'a'.repeat(40),
			documents: [{ path: 'documents/agreement.md', content: '# Agreement\n\nHello world.\n' }]
		});
		const fake = fakeDrafts();
		const service = new DocxImportService(
			fake as unknown as Pick<DraftPersistenceService, 'commit'>
		);

		const result = await service.importAndCommit({
			organizationId: 'org-1',
			envelopeId: '01900000-0000-7000-8000-000000000001',
			targetPath: 'documents/agreement.md',
			expectedGeneration: 0,
			actor,
			idempotencyKey: 'import-1',
			docxBytes: docx
		});

		expect(result.outcome).toBe('committed');
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toMatchObject({
			organizationId: 'org-1',
			envelopeId: '01900000-0000-7000-8000-000000000001',
			expectedGeneration: 0,
			idempotencyKey: 'import-1'
		});
		expect(fake.calls[0].edits).toEqual([
			{ path: 'documents/agreement.md', content: expect.stringContaining('# Agreement') }
		]);
	});

	it('propagates a hostile-input rejection without calling the draft store', async () => {
		const fake = fakeDrafts();
		const service = new DocxImportService(
			fake as unknown as Pick<DraftPersistenceService, 'commit'>
		);

		await expect(
			service.importAndCommit({
				organizationId: 'org-1',
				envelopeId: '01900000-0000-7000-8000-000000000001',
				targetPath: 'documents/agreement.md',
				expectedGeneration: 0,
				actor,
				idempotencyKey: 'import-2',
				docxBytes: new Uint8Array(0)
			})
		).rejects.toBeInstanceOf(DocxImportError);
		expect(fake.commit).not.toHaveBeenCalled();
	});
});
