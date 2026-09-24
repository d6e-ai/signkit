import { describe, expect, it } from 'vitest';
import {
	DraftDocumentNotFoundError,
	DraftIntegrityError,
	DraftPersistenceService,
	DraftRevisionNotFoundError
} from './draft-persistence';
import type {
	DraftMutationStore,
	DraftRevisionKey,
	DraftRevisionPreparation,
	PersistedDraftRevisionLocator,
	PublishedDraftRevision,
	PublishDraftRevisionCommand,
	PublishDraftRevisionResult
} from '$lib/ports/draft-mutation-store';
import type { DraftPointerUpdate } from '$lib/ports/envelope-store';
import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const actor = {
	id: '01900000-0000-7000-8000-000000000002',
	name: 'Contract Agent',
	email: 'agent@example.test',
	type: 'agent' as const
};

class InMemoryDraftStore implements DraftMutationStore {
	envelope: Envelope;
	locators: PersistedDraftRevisionLocator[] = [];

	constructor(envelope: Envelope) {
		this.envelope = envelope;
	}

	async findEnvelope(id: string): Promise<Envelope | null> {
		if (this.envelope.id !== id) return null;
		return { ...this.envelope };
	}

	async compareAndSetDraftPointer(id: string, update: DraftPointerUpdate): Promise<boolean> {
		if (
			this.envelope.id !== id ||
			this.envelope.repositoryGeneration !== update.expectedGeneration
		) {
			return false;
		}
		this.envelope = {
			...this.envelope,
			repositoryGeneration: update.nextGeneration,
			repositoryHead: update.commitSha,
			repositoryArchiveKey: update.archiveKey,
			repositoryArchiveSha256: update.archiveSha256,
			updatedAt: update.updatedAt
		};
		return true;
	}

	async transition(
		id: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean> {
		if (this.envelope.id !== id || this.envelope.status !== expected) return false;
		this.envelope = { ...this.envelope, status: next, updatedAt: at };
		return true;
	}

	async prepareDraftRevision(
		key: DraftRevisionKey,
		expectedGeneration: number
	): Promise<DraftRevisionPreparation> {
		if (this.envelope.id !== key.envelopeId) return { outcome: 'not_found' };
		if (this.envelope.status !== 'draft') return { outcome: 'immutable' };
		if (this.envelope.repositoryGeneration !== expectedGeneration)
			return { outcome: 'generation_conflict' };
		return {
			outcome: 'ready',
			envelope: { ...this.envelope },
			auditHead: { sequence: this.envelope.repositoryGeneration + 1, eventHash: 'a'.repeat(64) }
		};
	}

	async publishDraftRevision(
		command: PublishDraftRevisionCommand
	): Promise<PublishDraftRevisionResult> {
		const revision: PublishedDraftRevision = {
			generation: command.resultingGeneration,
			commitSha: command.commitSha,
			archiveKey: command.archiveKey,
			archiveSha256: command.archiveSha256,
			updatedAt: command.updatedAt,
			auditEventId: command.auditEventId
		};
		this.locators.push({
			envelopeId: command.envelopeId,
			generation: command.resultingGeneration,
			commitSha: command.commitSha,
			archiveKey: command.archiveKey,
			archiveSha256: command.archiveSha256,
			updatedAt: command.updatedAt,
			actorType: command.actorType,
			actorId: command.actorId,
			auditPayloadJson: command.auditPayloadJson
		});
		this.envelope = {
			...this.envelope,
			repositoryGeneration: command.resultingGeneration,
			repositoryHead: command.commitSha,
			repositoryArchiveKey: command.archiveKey,
			repositoryArchiveSha256: command.archiveSha256,
			updatedAt: command.updatedAt
		};
		return { outcome: 'published', revision };
	}

	async listDraftRevisionLocators(
		id: string,
		options?: { limit?: number; cursor?: number }
	): Promise<readonly PersistedDraftRevisionLocator[]> {
		let items = this.locators.filter((l) => l.envelopeId === id);
		if (options?.cursor !== undefined) {
			items = items.filter((l) => l.generation < options.cursor!);
		}
		items.sort((a, b) => b.generation - a.generation);
		const limit = Math.max(1, Math.min(options?.limit ?? 50, 100));
		return items.slice(0, limit);
	}

	async findDraftRevisionLocatorByGeneration(
		id: string,
		generation: number
	): Promise<PersistedDraftRevisionLocator | null> {
		const match = this.locators.find((l) => l.envelopeId === id && l.generation === generation);
		return match ? { ...match } : null;
	}

	async findDraftRevisionLocatorByCommit(
		id: string,
		commitSha: string
	): Promise<PersistedDraftRevisionLocator | null> {
		const match = this.locators.find((l) => l.envelopeId === id && l.commitSha === commitSha);
		return match ? { ...match } : null;
	}
}

function baseEnvelope(): Envelope {
	return {
		id: envelopeId,
		createdByUserId: 'user_1',
		title: 'Contract Agreement',
		status: 'draft',
		repositoryGeneration: 0,
		repositoryHead: null,
		repositoryArchiveKey: null,
		repositoryArchiveSha256: null,
		sentCommitSha: null,
		fieldGeneration: 0,
		createdAt: '2026-09-24T00:00:00.000Z',
		updatedAt: '2026-09-24T00:00:00.000Z'
	};
}

describe('DraftPersistenceService - revision history, reads, and diffs', () => {
	it('lists revision history with verified commit message, allowlisted provenance, without secrets', async () => {
		const store = new InMemoryDraftStore(baseEnvelope());
		const objects = new InMemoryObjectStore();
		const repository = new IsomorphicGitDraftRepository();
		const service = new DraftPersistenceService(store, objects, repository);

		// Commit generation 1
		await service.commit({
			envelopeId,
			expectedGeneration: 0,
			message: 'Initial draft terms',
			actor,
			idempotencyKey: 'idemp-1',
			provenance: { automationRunId: 'run-alpha', externalId: 'ext-123' },
			edits: [{ path: 'documents/nda.md', content: '# Initial NDA\nClause 1' }]
		});

		// Commit generation 2
		await service.commit({
			envelopeId,
			expectedGeneration: 1,
			message: 'Update confidentiality terms',
			actor,
			idempotencyKey: 'idemp-2',
			provenance: { automationRunId: 'run-beta' },
			edits: [
				{ path: 'documents/nda.md', content: '# Initial NDA\nClause 1 updated\nClause 2 added' }
			]
		});

		const getCallsBeforeHistory = objects.getCalls;
		const history = await service.listRevisions({ envelopeId });
		expect(objects.getCalls).toBe(getCallsBeforeHistory);
		expect(history.revisions).toHaveLength(2);
		expect(history.truncated).toBe(false);

		// Newest first
		const rev2 = history.revisions[0];
		expect(rev2.generation).toBe(2);
		expect(rev2.message).toBe('Update confidentiality terms');
		expect(rev2.actorType).toBe('agent');
		expect(rev2.provenance).toEqual({ automationRunId: 'run-beta' });
		// Confirm never exposing internal keys, secrets, audit hashes, or author email
		expect(JSON.stringify(history)).not.toContain('archiveKey');
		expect(JSON.stringify(history)).not.toContain('agent@example.test');
		expect(JSON.stringify(history)).not.toContain('audit_payload');
		expect(JSON.stringify(history)).not.toContain('audit_event_hash');

		const rev1 = history.revisions[1];
		expect(rev1.generation).toBe(1);
		expect(rev1.message).toBe('Initial draft terms');
		expect(rev1.provenance).toEqual({ automationRunId: 'run-alpha', externalId: 'ext-123' });
	});

	it('reads exact revision by generation and commit SHA, supporting path query', async () => {
		const store = new InMemoryDraftStore(baseEnvelope());
		const objects = new InMemoryObjectStore();
		const repository = new IsomorphicGitDraftRepository();
		const service = new DraftPersistenceService(store, objects, repository);

		const c1 = await service.commit({
			envelopeId,
			expectedGeneration: 0,
			message: 'Add document 1',
			actor,
			idempotencyKey: 'idemp-1',
			edits: [{ path: 'documents/doc1.md', content: '# Doc 1' }]
		});

		const revByGen = await service.readRevision({ envelopeId, revisionRef: '1' });
		expect(revByGen.generation).toBe(1);
		expect(revByGen.commitSha).toBe(c1.revision.commitSha);
		expect(revByGen.message).toBe('Add document 1');
		expect(revByGen.documents).toHaveLength(1);
		expect(revByGen.documents[0].content).toBe('# Doc 1\n');

		const revBySha = await service.readRevision({ envelopeId, revisionRef: c1.revision.commitSha });
		expect(revBySha.generation).toBe(1);
		const revByUppercaseSha = await service.readRevision({
			envelopeId,
			revisionRef: c1.revision.commitSha.toUpperCase()
		});
		expect(revByUppercaseSha.generation).toBe(1);

		// With path query
		const withPath = await service.readRevision({
			envelopeId,
			revisionRef: '1',
			path: 'documents/doc1.md'
		});
		expect(withPath.selectedDocument?.path).toBe('documents/doc1.md');
		expect(withPath.selectedDocument?.content).toBe('# Doc 1\n');

		// Unknown path
		await expect(
			service.readRevision({ envelopeId, revisionRef: '1', path: 'documents/unknown.md' })
		).rejects.toBeInstanceOf(DraftDocumentNotFoundError);

		// Unknown revision
		await expect(service.readRevision({ envelopeId, revisionRef: '99' })).rejects.toBeInstanceOf(
			DraftRevisionNotFoundError
		);
	});

	it('computes structured diff across multi-document edits, additions, and non-adjacent revisions', async () => {
		const store = new InMemoryDraftStore(baseEnvelope());
		const objects = new InMemoryObjectStore();
		const repository = new IsomorphicGitDraftRepository();
		const service = new DraftPersistenceService(store, objects, repository);

		// Gen 1: Add doc1 and doc2
		await service.commit({
			envelopeId,
			expectedGeneration: 0,
			message: 'Gen 1',
			actor,
			idempotencyKey: 'idemp-1',
			edits: [
				{ path: 'documents/doc1.md', content: '# Doc 1\nLine 1' },
				{ path: 'documents/doc2.md', content: '# Doc 2\nLine 1' }
			]
		});

		// Gen 2: Update doc1
		await service.commit({
			envelopeId,
			expectedGeneration: 1,
			message: 'Gen 2',
			actor,
			idempotencyKey: 'idemp-2',
			edits: [{ path: 'documents/doc1.md', content: '# Doc 1\nLine 1 modified\nLine 2 added' }]
		});

		// Gen 3: Reorder and add doc3
		await service.commit({
			envelopeId,
			expectedGeneration: 2,
			message: 'Gen 3',
			actor,
			idempotencyKey: 'idemp-3',
			edits: [{ path: 'documents/doc3.md', content: '# Doc 3' }]
		});

		// Diff gen 0 to gen 1 (base=0, head=1)
		const diffGen0to1 = await service.diffRevisions({ envelopeId, baseRef: '0', headRef: '1' });
		expect(diffGen0to1.summary.documentsAdded).toBe(2);
		expect(diffGen0to1.changes.every((c) => c.addition)).toBe(true);

		// Diff gen 1 to gen 2 (adjacent)
		const diffGen1to2 = await service.diffRevisions({ envelopeId, baseRef: '1', headRef: '2' });
		expect(diffGen1to2.summary.documentsModified).toBe(1);
		const doc1Change = diffGen1to2.changes.find((c) => c.path === 'documents/doc1.md')!;
		expect(doc1Change.contentChanged).toBe(true);
		expect(doc1Change.content.unifiedDiff).toContain('-Line 1');
		expect(doc1Change.content.unifiedDiff).toContain('+Line 1 modified');

		// Diff gen 1 to gen 3 (non-adjacent)
		const diffGen1to3 = await service.diffRevisions({ envelopeId, baseRef: '1', headRef: '3' });
		expect(diffGen1to3.base.generation).toBe(1);
		expect(diffGen1to3.head.generation).toBe(3);
		expect(diffGen1to3.summary.documentsAdded).toBe(1); // doc3
		expect(diffGen1to3.summary.documentsModified).toBe(1); // doc1
	});

	it('fails closed on corrupted archive byte digest (tamper detection)', async () => {
		const store = new InMemoryDraftStore(baseEnvelope());
		const objects = new InMemoryObjectStore();
		const repository = new IsomorphicGitDraftRepository();
		const service = new DraftPersistenceService(store, objects, repository);

		const c1 = await service.commit({
			envelopeId,
			expectedGeneration: 0,
			message: 'Commit 1',
			actor,
			idempotencyKey: 'idemp-1',
			edits: [{ path: 'documents/doc1.md', content: '# Doc 1' }]
		});

		// Tamper with archive in object store
		objects.seed(c1.revision.archiveKey, new Uint8Array([1, 2, 3, 4, 5]), 'tampered-sha');

		// readRevision should detect SHA-256 mismatch and fail closed
		await expect(service.readRevision({ envelopeId, revisionRef: '1' })).rejects.toBeInstanceOf(
			DraftIntegrityError
		);

		// diffRevisions should detect SHA-256 mismatch and fail closed
		await expect(service.diffRevisions({ envelopeId, headRef: '1' })).rejects.toBeInstanceOf(
			DraftIntegrityError
		);
	});
});
