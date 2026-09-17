import { describe, expect, it } from 'vitest';
import type { EnvelopeDocument } from '$lib/domain/envelope';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import type {
	EnvelopeDocumentInput,
	EnvelopeDocumentStore
} from '$lib/ports/envelope-document-store';
import {
	EnvelopeDocumentApplication,
	InvalidEnvelopeDocumentInputError,
	titleFromMarkdownPath
} from './envelope-documents';

const actor: EnvelopeRequestActor = {
	id: 'user-1',
	createdByUserId: 'user-1'
};
const envelopeId: string = '01900000-0000-7000-8000-000000000001';

class FakeStore implements EnvelopeDocumentStore {
	documents: EnvelopeDocument[] = [];
	syncCalls: Array<readonly EnvelopeDocumentInput[]> = [];

	async listForEnvelope(envelopeIdArg: string): Promise<readonly EnvelopeDocument[]> {
		return this.documents.filter((document) => document.envelopeId === envelopeIdArg);
	}

	async sync(
		envelopeIdArg: string,
		documents: readonly EnvelopeDocumentInput[]
	): Promise<readonly EnvelopeDocument[]> {
		this.syncCalls.push(documents);
		this.documents = documents.map((document, index) => ({
			id: `doc-${index}`,
			envelopeId: envelopeIdArg,
			markdownPath: document.markdownPath,
			title: document.title ?? titleFromMarkdownPath(document.markdownPath),
			position: index
		}));
		return this.documents;
	}

	async renameDocument(): Promise<EnvelopeDocument | null> {
		return null;
	}
}

describe('titleFromMarkdownPath', () => {
	it('title-cases separators and strips the extension', () => {
		expect(titleFromMarkdownPath('documents/master-services_agreement.md')).toBe(
			'Master Services Agreement'
		);
	});

	it('falls back to a stable placeholder for a degenerate name', () => {
		expect(titleFromMarkdownPath('documents/---.md')).toBe('Untitled document');
	});
});

describe('EnvelopeDocumentApplication', () => {
	it('syncs valid markdown paths and rejects duplicates', async () => {
		const store = new FakeStore();
		const application = new EnvelopeDocumentApplication(store);
		const result = await application.syncFromPaths(actor, envelopeId, [
			'documents/agreement.md',
			'documents/appendix.md'
		]);
		expect(result.map((document) => document.title)).toEqual(['Agreement', 'Appendix']);

		await expect(
			application.syncFromPaths(actor, envelopeId, [
				'documents/agreement.md',
				'documents/agreement.md'
			])
		).rejects.toBeInstanceOf(InvalidEnvelopeDocumentInputError);
	});

	it('rejects a path outside documents/', async () => {
		const application = new EnvelopeDocumentApplication(new FakeStore());
		await expect(
			application.syncFromPaths(actor, envelopeId, ['../etc/passwd.md'])
		).rejects.toThrow();
	});

	it('validates rename input before delegating to the store', async () => {
		const application = new EnvelopeDocumentApplication(new FakeStore());
		await expect(
			application.rename(actor, envelopeId, 'documents/agreement.md', '   ')
		).rejects.toBeInstanceOf(InvalidEnvelopeDocumentInputError);
		await expect(
			application.rename(actor, envelopeId, 'documents/agreement.md', 'Valid Title')
		).resolves.toBeNull();
	});
});
