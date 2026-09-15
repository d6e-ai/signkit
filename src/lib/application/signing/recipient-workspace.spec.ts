import { describe, expect, it, vi } from 'vitest';
import type { EnvelopeSentPdfStore, SentPdfPointer } from '$lib/ports/envelope-sent-pdf-store';
import type {
	EnvelopeSentDocumentStore,
	SentDocumentPointer,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';
import type { RecipientOwnFields } from '$lib/ports/recipient-field-declaration-store';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { RecipientAccessApplicationPort } from './recipient-access';
import {
	RecipientWorkspaceIntegrityError,
	RecipientWorkspaceService,
	type RecipientFieldReader
} from './recipient-workspace';

const TOKEN: string = `skr1_${'A'.repeat(43)}`;

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

const pointer: SentPdfPointer = {
	organizationId: 'org-secret',
	envelopeId: 'env-1',
	commitSha: 'a'.repeat(40),
	objectKey:
		'sent-documents/v1/organizations/org-secret/envelopes/env-1/sha256/' + 'e'.repeat(64) + '.pdf',
	sha256: 'e'.repeat(64),
	byteSize: 2048,
	pageCount: 3,
	pageWidth: 595.28,
	pageHeight: 841.89,
	documents: [{ path: 'documents/agreement.md', title: 'agreement', firstPage: 1, lastPage: 3 }],
	createdAt: '2026-09-11T00:00:00.000Z'
};

const noFields: RecipientFieldReader = async (): Promise<RecipientOwnFields> => ({
	fieldGeneration: 1,
	fields: []
});

function application(
	...results: readonly (RecipientSigningContext | null)[]
): RecipientAccessApplicationPort {
	const resolve = vi.fn();
	for (const result of results) resolve.mockResolvedValueOnce(result);
	return { resolve };
}

function sentPdf(result: SentPdfPointer | null = pointer): EnvelopeSentPdfStore {
	return { findSentPdf: vi.fn(async (): Promise<SentPdfPointer | null> => result) };
}

function emptySentDocuments(): EnvelopeSentDocumentStore {
	return {
		findSet: vi.fn(async () => null),
		findDocument: vi.fn(async () => null)
	};
}

describe('RecipientWorkspaceService', () => {
	it('pins the sent rendering, reauthorizes, and returns only public geometry', async () => {
		const access: RecipientAccessApplicationPort = application(context, {
			...context,
			recipientStatus: 'viewed',
			envelopeStatus: 'in_progress'
		});
		const store: EnvelopeSentPdfStore = sentPdf();
		const readFields: RecipientFieldReader = vi.fn(async (): Promise<RecipientOwnFields> => ({
			fieldGeneration: 1,
			fields: [
				{
					id: 'field-1',
					documentId: null,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Your signature',
					required: true,
					position: 0,
					geometry: { page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
				}
			]
		}));
		const workspace = await new RecipientWorkspaceService(
			access,
			emptySentDocuments(),
			store,
			readFields,
			() => new Date('2026-09-11T00:00:01.000Z')
		).resolve(TOKEN, '2026-09-11T00:00:00.000Z');

		expect(store.findSentPdf).toHaveBeenCalledWith('org-secret', 'env-1', 'a'.repeat(40));
		expect(readFields).toHaveBeenCalledWith({
			organizationId: 'org-secret',
			envelopeId: 'env-1',
			recipientId: 'recipient-1'
		});
		expect(access.resolve).toHaveBeenCalledTimes(2);
		expect(access.resolve).toHaveBeenNthCalledWith(2, TOKEN, '2026-09-11T00:00:01.000Z');
		expect(workspace).toEqual({
			access: {
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				recipientName: 'Private Recipient',
				role: 'signer',
				locale: 'en',
				recipientStatus: 'viewed',
				envelopeTitle: 'Agreement',
				envelopeStatus: 'in_progress',
				expiresAt: '2026-09-12T00:00:00.000Z'
			},
			documents: [
				{
					documentId: 'legacy',
					position: 0,
					title: 'agreement',
					kind: 'legacy',
					pageCount: 3,
					pageWidth: 595.28,
					pageHeight: 841.89
				}
			],
			source: 'legacy',
			fields: [
				{
					id: 'field-1',
					documentId: 'legacy',
					fieldType: 'signature',
					label: 'Your signature',
					required: true,
					geometry: { page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
				}
			],
			fieldGeneration: 1
		});
		// No Markdown path, no archive key, no organization identifier, no object
		// key: the page payload describes the rendering, never how it is stored.
		expect(JSON.stringify(workspace)).not.toMatch(
			/org-secret|private\/archive|sent-documents|documents\/agreement\.md|[a-f0-9]{64}/
		);
	});

	it('does not read the pointer for inactive access', async () => {
		const store: EnvelopeSentPdfStore = sentPdf();
		await expect(
			new RecipientWorkspaceService(
				application(null),
				emptySentDocuments(),
				store,
				noFields
			).resolve(TOKEN, '2026-09-11T00:00:00.000Z')
		).resolves.toBeNull();
		expect(store.findSentPdf).not.toHaveBeenCalled();
	});

	it('withholds the workspace when access is revoked during the read', async () => {
		await expect(
			new RecipientWorkspaceService(
				application(context, null),
				emptySentDocuments(),
				sentPdf(),
				noFields
			).resolve(TOKEN, '2026-09-11T00:00:00.000Z')
		).resolves.toBeNull();
	});

	it('fails closed when the field-generation pointer cannot be read', async () => {
		await expect(
			new RecipientWorkspaceService(
				application(context, context),
				emptySentDocuments(),
				sentPdf(),
				async () => null
			).resolve(TOKEN, '2026-09-11T00:00:00.000Z')
		).rejects.toBeInstanceOf(RecipientWorkspaceIntegrityError);
	});

	it('fails closed when the sent revision has no published rendering', async () => {
		await expect(
			new RecipientWorkspaceService(
				application(context),
				emptySentDocuments(),
				sentPdf(null),
				noFields
			).resolve(TOKEN, '2026-09-11T00:00:00.000Z')
		).rejects.toBeInstanceOf(RecipientWorkspaceIntegrityError);
	});

	it.each([
		['missing geometry', null],
		['a page outside its own document', { page: 4, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
		['a box past the right edge', { page: 1, x: 0.95, y: 0.1, width: 0.2, height: 0.05 }],
		['a non-finite coordinate', { page: 1, x: Number.NaN, y: 0.1, width: 0.2, height: 0.05 }],
		['a zero-sized box', { page: 1, x: 0.1, y: 0.1, width: 0, height: 0.05 }]
	] as const)('refuses to disclose a workspace with %s', async (_name, geometry) => {
		await expect(
			new RecipientWorkspaceService(
				application(context, context),
				emptySentDocuments(),
				sentPdf(),
				async () => ({
					fieldGeneration: 1,
					fields: [
						{
							id: 'field-1',
							documentId: null,
							documentPath: 'documents/agreement.md',
							fieldType: 'signature',
							label: 'Your signature',
							required: true,
							position: 0,
							geometry
						}
					]
				})
			).resolve(TOKEN, '2026-09-11T00:00:00.000Z')
		).rejects.toBeInstanceOf(RecipientWorkspaceIntegrityError);
	});

	it('propagates pointer store failures', async () => {
		await expect(
			new RecipientWorkspaceService(
				application(context),
				emptySentDocuments(),
				{
					findSentPdf: async (): Promise<SentPdfPointer> => {
						throw new Error('pointer store failed');
					}
				},
				noFields
			).resolve(TOKEN, '2026-09-11T00:00:00.000Z')
		).rejects.toThrow('pointer store failed');
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
				new RecipientWorkspaceService(
					application(context, changed),
					emptySentDocuments(),
					sentPdf(),
					noFields
				).resolve(TOKEN, '2026-09-11T00:00:00.000Z')
			).rejects.toBeInstanceOf(RecipientWorkspaceIntegrityError);
		}
	);

	it('exposes each pinned document separately, never a concatenated page map', async () => {
		const first: SentDocumentPointer = {
			organizationId: 'org-secret',
			envelopeId: 'env-1',
			commitSha: 'a'.repeat(40),
			documentId: '01900000-0000-7000-8000-000000000021',
			position: 0,
			kind: 'markdown',
			title: 'NDA',
			objectKey:
				'sent-documents/v1/organizations/org-secret/envelopes/env-1/sha256/' +
				'c'.repeat(64) +
				'.pdf',
			sha256: 'c'.repeat(64),
			byteSize: 1024,
			pageCount: 2,
			pageWidth: 595.28,
			pageHeight: 841.89,
			createdAt: '2026-09-11T00:00:00.000Z'
		};
		const second: SentDocumentPointer = {
			...first,
			documentId: '01900000-0000-7000-8000-000000000022',
			position: 1,
			kind: 'pdf',
			title: 'Schedule A',
			objectKey:
				'sent-documents/v1/organizations/org-secret/envelopes/env-1/sha256/' +
				'd'.repeat(64) +
				'.pdf',
			sha256: 'd'.repeat(64),
			byteSize: 2048,
			pageCount: 4
		};
		const set: SentDocumentSetPointer = {
			organizationId: 'org-secret',
			envelopeId: 'env-1',
			commitSha: 'a'.repeat(40),
			documentSetHash: 'e'.repeat(64),
			documentCount: 2,
			documents: [first, second],
			createdAt: '2026-09-11T00:00:00.000Z'
		};
		const documents: EnvelopeSentDocumentStore = {
			findSet: vi.fn(async () => set),
			findDocument: vi.fn(async () => first)
		};
		const store: EnvelopeSentPdfStore = sentPdf();
		const readFields: RecipientFieldReader = vi.fn(async (): Promise<RecipientOwnFields> => ({
			fieldGeneration: 1,
			fields: [
				{
					id: 'field-1',
					documentId: second.documentId,
					documentPath: null,
					fieldType: 'signature',
					label: 'Your signature',
					required: true,
					position: 0,
					geometry: { page: 3, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
				}
			]
		}));

		const workspace = await new RecipientWorkspaceService(
			application(context, context),
			documents,
			store,
			readFields
		).resolve(TOKEN, '2026-09-11T00:00:00.000Z');

		expect(store.findSentPdf).not.toHaveBeenCalled();
		expect(workspace?.source).toBe('document-set');
		expect(workspace?.documents).toEqual([
			{
				documentId: first.documentId,
				position: 0,
				title: 'NDA',
				kind: 'markdown',
				pageCount: 2,
				pageWidth: 595.28,
				pageHeight: 841.89
			},
			{
				documentId: second.documentId,
				position: 1,
				title: 'Schedule A',
				kind: 'pdf',
				pageCount: 4,
				pageWidth: 595.28,
				pageHeight: 841.89
			}
		]);
		expect(workspace?.fields).toEqual([
			{
				id: 'field-1',
				documentId: second.documentId,
				fieldType: 'signature',
				label: 'Your signature',
				required: true,
				geometry: { page: 3, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
			}
		]);
		expect(JSON.stringify(workspace)).not.toMatch(
			/org-secret|private\/archive|sent-documents|[a-f0-9]{64}/
		);
	});
});
