import { describe, expect, it, vi } from 'vitest';
import type { DraftDocument } from '$lib/ports/draft-repository';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { RecipientAccessApplicationPort } from './recipient-access';
import {
	RecipientWorkspaceIntegrityError,
	RecipientWorkspaceService,
	type RecipientRevisionReader
} from './recipient-workspace';

const context: RecipientSigningContext = {
	organizationId: 'org-secret',
	envelopeId: 'env-1',
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

function application(
	...results: readonly (RecipientSigningContext | null)[]
): RecipientAccessApplicationPort {
	const resolve = vi.fn();
	for (const result of results) resolve.mockResolvedValueOnce(result);
	return { resolve };
}

describe('RecipientWorkspaceService', () => {
	it('reads the trusted pinned revision, reauthorizes, and returns only public data', async () => {
		const access: RecipientAccessApplicationPort = application(context, {
			...context,
			recipientStatus: 'viewed',
			envelopeStatus: 'in_progress'
		});
		const readRevision: RecipientRevisionReader = vi.fn(
			async (): Promise<readonly DraftDocument[]> => [
				{ path: 'documents/agreement.md', content: '# Agreement\n' }
			]
		);
		const workspace = await new RecipientWorkspaceService(
			access,
			readRevision,
			() => new Date('2026-09-11T00:00:01.000Z')
		).resolve(`skr1_${'A'.repeat(43)}`, '2026-09-11T00:00:00.000Z');

		expect(readRevision).toHaveBeenCalledWith({
			organizationId: 'org-secret',
			envelopeId: 'env-1',
			...context.sentRevision
		});
		expect(access.resolve).toHaveBeenCalledTimes(2);
		expect(access.resolve).toHaveBeenNthCalledWith(
			2,
			`skr1_${'A'.repeat(43)}`,
			'2026-09-11T00:00:01.000Z'
		);
		expect(workspace).toEqual({
			access: {
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				role: 'signer',
				locale: 'en',
				recipientStatus: 'viewed',
				envelopeTitle: 'Agreement',
				envelopeStatus: 'in_progress',
				expiresAt: '2026-09-12T00:00:00.000Z'
			},
			documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
		});
		expect(JSON.stringify(workspace)).not.toMatch(/org-secret|Private Recipient|private\/archive/);
	});

	it('does not read object storage for inactive access', async () => {
		const readRevision: RecipientRevisionReader = vi.fn();
		await expect(
			new RecipientWorkspaceService(application(null), readRevision).resolve(
				`skr1_${'A'.repeat(43)}`,
				'2026-09-11T00:00:00.000Z'
			)
		).resolves.toBeNull();
		expect(readRevision).not.toHaveBeenCalled();
	});

	it('withholds documents when access is revoked during the archive read', async () => {
		await expect(
			new RecipientWorkspaceService(application(context, null), async () => [
				{ path: 'documents/agreement.md', content: 'private\n' }
			]).resolve(`skr1_${'A'.repeat(43)}`, '2026-09-11T00:00:00.000Z')
		).resolves.toBeNull();
	});

	it('rejects a sent revision without tracked documents', async () => {
		await expect(
			new RecipientWorkspaceService(application(context), async () => []).resolve(
				`skr1_${'A'.repeat(43)}`,
				'2026-09-11T00:00:00.000Z'
			)
		).rejects.toBeInstanceOf(RecipientWorkspaceIntegrityError);
	});

	it('propagates immutable archive reader failures', async () => {
		await expect(
			new RecipientWorkspaceService(application(context), async () => {
				throw new Error('archive failed');
			}).resolve(`skr1_${'A'.repeat(43)}`, '2026-09-11T00:00:00.000Z')
		).rejects.toThrow('archive failed');
	});

	it.each([
		['organization', { ...context, organizationId: 'org-2' }],
		['envelope', { ...context, envelopeId: 'env-2' }],
		['recipient', { ...context, recipientId: 'recipient-2' }],
		[
			'commit',
			{ ...context, sentRevision: { ...context.sentRevision, commitSha: 'c'.repeat(40) } }
		],
		[
			'archive key',
			{ ...context, sentRevision: { ...context.sentRevision, archiveKey: 'other/archive.git.gz' } }
		],
		[
			'archive digest',
			{ ...context, sentRevision: { ...context.sentRevision, archiveSha256: 'd'.repeat(64) } }
		]
	] as const)(
		'fails closed if the durable %s boundary changes during the read',
		async (_name, changed) => {
			await expect(
				new RecipientWorkspaceService(application(context, changed), async () => [
					{ path: 'documents/agreement.md', content: 'private\n' }
				]).resolve(`skr1_${'A'.repeat(43)}`, '2026-09-11T00:00:00.000Z')
			).rejects.toBeInstanceOf(RecipientWorkspaceIntegrityError);
		}
	);
});
