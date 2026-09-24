import { describe, expect, it } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import { renderAgreementPdf } from '$lib/adapters/pdf/agreement-pdf';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type {
	DraftMutationStore,
	DraftRevisionKey,
	DraftRevisionPreparation,
	PersistedDraftRevisionLocator,
	PublishDraftRevisionCommand,
	PublishDraftRevisionResult,
	PublishedDraftRevision
} from '$lib/ports/draft-mutation-store';
import type { DraftPointerUpdate } from '$lib/ports/envelope-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import type {
	EnvelopeUploadedDocumentRecord,
	EnvelopeUploadedDocumentStore,
	InsertUploadedDocumentResult
} from '$lib/ports/envelope-uploaded-document-store';
import {
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftPersistenceService,
	type CommitDraftResult
} from '$lib/application/drafts/draft-persistence';
import {
	UploadedPdfUploadError,
	UploadedPdfUploadService,
	type UploadPdfInput
} from './uploaded-pdf-upload-service';

const ENVELOPE_ID = 'env_1';
const actor = { id: 'user_1', name: 'Yu Kimura', email: 'yu@example.test', type: 'user' as const };

function validPdfBytes(): Uint8Array {
	return renderAgreementPdf([
		{ title: 'Agreement', nodes: renderRecipientMarkdown('# Agreement\n\nHello.\n').nodes }
	]).bytes;
}

class FakeUploadedDocumentStore implements EnvelopeUploadedDocumentStore {
	inserted: EnvelopeUploadedDocumentRecord[] = [];
	nextResult: InsertUploadedDocumentResult = 'inserted';

	async insert(record: EnvelopeUploadedDocumentRecord): Promise<InsertUploadedDocumentResult> {
		if (this.nextResult === 'inserted') this.inserted.push(record);
		return this.nextResult;
	}

	async find(__envelopeId: string, sha256: string): Promise<EnvelopeUploadedDocumentRecord | null> {
		return this.inserted.find((record) => record.sha256 === sha256) ?? null;
	}
}

function emptyEnvelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		id: ENVELOPE_ID,
		createdByUserId: 'user_1',
		title: 'Agreement',
		status: 'draft',
		repositoryGeneration: 0,
		repositoryHead: null,
		repositoryArchiveKey: null,
		repositoryArchiveSha256: null,
		sentCommitSha: null,
		fieldGeneration: 0,
		createdAt: '2026-09-11T00:00:00.000Z',
		updatedAt: '2026-09-11T00:00:00.000Z',
		...overrides
	};
}

function commandKey(key: DraftRevisionKey): string {
	return [key.actorType, key.actorId, key.idempotencyKey].join('\u0000');
}

/** A trimmed copy of draft-persistence.spec.ts's MemoryEnvelopeStore, for this file's own fixtures. */
class MemoryEnvelopeStore implements DraftMutationStore {
	private envelope: Envelope;
	private readonly commands = new Map<
		string,
		{ requestFingerprint: string; envelopeId: string; revision: PublishedDraftRevision }
	>();

	constructor(envelope: Envelope) {
		this.envelope = envelope;
	}

	async findEnvelope(envelopeId: string): Promise<Envelope | null> {
		if (this.envelope.id !== envelopeId) {
			return null;
		}
		return { ...this.envelope };
	}

	async compareAndSetDraftPointer(
		envelopeId: string,
		update: DraftPointerUpdate
	): Promise<boolean> {
		if (
			this.envelope.id !== envelopeId ||
			this.envelope.status !== 'draft' ||
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

	async prepareDraftRevision(
		key: DraftRevisionKey,
		expectedGeneration: number
	): Promise<DraftRevisionPreparation> {
		const existing = this.commands.get(commandKey(key));
		if (existing !== undefined) {
			return existing.requestFingerprint === key.requestFingerprint &&
				existing.envelopeId === key.envelopeId
				? { outcome: 'replayed', revision: existing.revision }
				: { outcome: 'idempotency_conflict' };
		}
		if (this.envelope.id !== key.envelopeId) {
			return { outcome: 'not_found' };
		}
		if (this.envelope.status !== 'draft') return { outcome: 'immutable' };
		if (this.envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		return {
			outcome: 'ready',
			envelope: { ...this.envelope },
			auditHead: { sequence: this.envelope.repositoryGeneration + 1, eventHash: 'a'.repeat(64) }
		};
	}

	async publishDraftRevision(
		command: PublishDraftRevisionCommand
	): Promise<PublishDraftRevisionResult> {
		const existing = this.commands.get(commandKey(command));
		if (existing !== undefined) {
			return existing.requestFingerprint === command.requestFingerprint &&
				existing.envelopeId === command.envelopeId
				? { outcome: 'replayed', revision: existing.revision }
				: { outcome: 'idempotency_conflict' };
		}
		if (this.envelope.id !== command.envelopeId) {
			return { outcome: 'not_found' };
		}
		if (this.envelope.status !== 'draft') return { outcome: 'immutable' };
		if (this.envelope.repositoryGeneration !== command.expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		this.envelope = {
			...this.envelope,
			repositoryGeneration: command.resultingGeneration,
			repositoryHead: command.commitSha,
			repositoryArchiveKey: command.archiveKey,
			repositoryArchiveSha256: command.archiveSha256,
			updatedAt: command.updatedAt
		};
		const revision: PublishedDraftRevision = {
			generation: command.resultingGeneration,
			commitSha: command.commitSha,
			archiveKey: command.archiveKey,
			archiveSha256: command.archiveSha256,
			updatedAt: command.updatedAt,
			auditEventId: command.auditEventId
		};
		this.commands.set(commandKey(command), {
			requestFingerprint: command.requestFingerprint,
			envelopeId: command.envelopeId,
			revision
		});
		return { outcome: 'published', revision };
	}

	async transition(): Promise<boolean> {
		return false;
	}

	async listDraftRevisionLocators(): Promise<PersistedDraftRevisionLocator[]> {
		return [];
	}

	async findDraftRevisionLocatorByGeneration(): Promise<PersistedDraftRevisionLocator | null> {
		return null;
	}

	async findDraftRevisionLocatorByCommit(): Promise<PersistedDraftRevisionLocator | null> {
		return null;
	}
}

function harness(envelope: Envelope = emptyEnvelope()): {
	drafts: DraftPersistenceService;
	objects: InMemoryObjectStore;
	uploadedDocuments: FakeUploadedDocumentStore;
	service: UploadedPdfUploadService;
} {
	const objects = new InMemoryObjectStore();
	const uploadedDocuments = new FakeUploadedDocumentStore();
	const drafts = new DraftPersistenceService(
		new MemoryEnvelopeStore(envelope),
		objects,
		new IsomorphicGitDraftRepository(),
		uploadedDocuments
	);
	const service = new UploadedPdfUploadService(drafts, objects, uploadedDocuments);
	return { drafts, objects, uploadedDocuments, service };
}

function uploadInput(overrides: Partial<UploadPdfInput> = {}): UploadPdfInput {
	return {
		envelopeId: ENVELOPE_ID,
		expectedGeneration: 0,
		actor,
		idempotencyKey: 'upload-1',
		bytes: validPdfBytes(),
		filename: 'Agreement.pdf',
		updatedAt: '2026-09-11T00:00:00.000Z',
		...overrides
	};
}

describe('UploadedPdfUploadService', () => {
	it('uploads a PDF, stores the object, inserts the ledger row, and commits the manifest', async () => {
		const { service, objects, uploadedDocuments, drafts } = harness();
		const bytes = validPdfBytes();
		const result: CommitDraftResult = await service.upload(uploadInput({ bytes }));

		expect(result.outcome).toBe('committed');
		expect(uploadedDocuments.inserted).toHaveLength(1);
		expect(uploadedDocuments.inserted[0]).toMatchObject({
			envelopeId: ENVELOPE_ID,
			byteSize: bytes.byteLength
		});
		expect(objects.keys().some((key) => key.startsWith('uploaded-documents/v1/'))).toBe(true);

		const workspace = await drafts.readWorkspace({
			envelopeId: ENVELOPE_ID
		});
		expect(workspace.documents).toEqual([]);
		expect(workspace.documentSet?.documents).toHaveLength(1);
		expect(workspace.documentSet?.documents[0]).toMatchObject({
			kind: 'pdf',
			title: 'Agreement'
		});
	});

	it('replays an identical idempotency key without writing a second object', async () => {
		const { service, objects } = harness();
		const bytes = validPdfBytes();
		const first = await service.upload(uploadInput({ bytes }));
		const objectCountAfterFirst = objects.size;
		const second = await service.upload(uploadInput({ bytes }));

		expect(second.outcome).toBe('replayed');
		expect(second.revision.commitSha).toBe(first.revision.commitSha);
		expect(objects.size).toBe(objectCountAfterFirst);
	});

	it('rejects a stale expected generation', async () => {
		const { service } = harness(emptyEnvelope({ repositoryGeneration: 1 }));
		await expect(service.upload(uploadInput({ expectedGeneration: 0 }))).rejects.toBeInstanceOf(
			DraftGenerationConflictError
		);
	});

	it('appends a PDF leaf beside existing Markdown', async () => {
		const { service, drafts } = harness();
		await drafts.commit({
			envelopeId: ENVELOPE_ID,
			expectedGeneration: 0,
			edits: [{ path: 'documents/agreement.md', content: '# Agreement' }],
			message: 'Create agreement',
			actor,
			idempotencyKey: 'markdown-1'
		});

		const result = await service.upload(uploadInput({ expectedGeneration: 1 }));
		expect(result.outcome).toBe('committed');
		const workspace = await drafts.readWorkspace({
			envelopeId: ENVELOPE_ID
		});
		expect(workspace.documents).toEqual([
			{ path: 'documents/agreement.md', content: '# Agreement\n' }
		]);
		expect(workspace.documentSet?.documents.map((leaf) => leaf.kind)).toEqual(['markdown', 'pdf']);
	});

	it('rejects an empty or oversized upload as too_large', async () => {
		const { service } = harness();
		await expect(service.upload(uploadInput({ bytes: new Uint8Array(0) }))).rejects.toMatchObject({
			reason: 'too_large'
		});
	});

	it('rejects a structurally invalid PDF as invalid_pdf', async () => {
		const { service } = harness();
		await expect(
			service.upload(uploadInput({ bytes: new TextEncoder().encode('not a pdf') }))
		).rejects.toMatchObject({ reason: 'invalid_pdf' });
	});

	it('refuses the upload once the per-envelope digest cap is reached', async () => {
		const { service, uploadedDocuments } = harness();
		uploadedDocuments.nextResult = 'cap_exceeded';
		await expect(service.upload(uploadInput())).rejects.toBeInstanceOf(UploadedPdfUploadError);
		await expect(service.upload(uploadInput())).rejects.toMatchObject({ reason: 'cap_exceeded' });
	});

	it('surfaces a missing envelope from the ledger insert', async () => {
		const { service, uploadedDocuments } = harness();
		uploadedDocuments.nextResult = 'not_found';
		await expect(service.upload(uploadInput())).rejects.toBeInstanceOf(DraftEnvelopeNotFoundError);
	});

	it('recovers when putImmutable throws after actually storing a matching object', async () => {
		const { service, objects } = harness();
		objects.throwAfterNextPut = true;
		const result = await service.upload(uploadInput());
		expect(result.outcome).toBe('committed');
	});

	it('rethrows when putImmutable fails and no matching object was ever stored', async () => {
		const failingObjects: ObjectStore = {
			async head(): Promise<ObjectMetadata | null> {
				return null;
			},
			async get(): Promise<ReadableStream<Uint8Array> | null> {
				return null;
			},
			async putImmutable(): Promise<ObjectMetadata> {
				throw new Error('store unavailable');
			},
			async delete(): Promise<void> {},
			async deleteMany(): Promise<void> {},
			async list() {
				return { objects: [], truncated: false };
			}
		};
		const uploadedDocuments = new FakeUploadedDocumentStore();
		const drafts = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			failingObjects,
			new IsomorphicGitDraftRepository(),
			uploadedDocuments
		);
		const service = new UploadedPdfUploadService(drafts, failingObjects, uploadedDocuments);
		await expect(service.upload(uploadInput())).rejects.toThrow('store unavailable');
	});

	it('rethrows when a stored object under the same key has a mismatching digest', async () => {
		const bytes = validPdfBytes();
		const key: { current: string | null } = { current: null };
		const mismatchObjects: ObjectStore = {
			async head(): Promise<ObjectMetadata | null> {
				if (key.current === null) return null;
				return {
					key: key.current,
					contentType: 'application/pdf',
					size: 1,
					sha256: 'f'.repeat(64),
					version: null
				};
			},
			async get(): Promise<ReadableStream<Uint8Array> | null> {
				return null;
			},
			async putImmutable(putKey: string): Promise<ObjectMetadata> {
				key.current = putKey;
				throw new Error('response lost');
			},
			async delete(): Promise<void> {},
			async deleteMany(): Promise<void> {},
			async list() {
				return { objects: [], truncated: false };
			}
		};
		const uploadedDocuments = new FakeUploadedDocumentStore();
		const drafts = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			mismatchObjects,
			new IsomorphicGitDraftRepository(),
			uploadedDocuments
		);
		const service = new UploadedPdfUploadService(drafts, mismatchObjects, uploadedDocuments);
		await expect(service.upload(uploadInput({ bytes }))).rejects.toThrow('response lost');
	});
});
