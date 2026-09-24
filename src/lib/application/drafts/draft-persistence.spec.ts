import { describe, expect, it } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type {
	DraftMutationStore,
	DraftRevisionKey,
	DraftRevisionPreparation,
	PersistedDraftRevisionLocator,
	PublishedDraftRevision,
	PublishDraftRevisionCommand,
	PublishDraftRevisionResult
} from '$lib/ports/draft-mutation-store';
import type {
	DraftActor,
	DraftEdit,
	DraftRepository,
	DraftVersion
} from '$lib/ports/draft-repository';
import type { DraftPointerUpdate } from '$lib/ports/envelope-store';
import type {
	EnvelopeUploadedDocumentRecord,
	EnvelopeUploadedDocumentStore,
	InsertUploadedDocumentResult
} from '$lib/ports/envelope-uploaded-document-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import {
	DraftDocumentSetError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	DraftIntegrityError,
	DraftPersistenceService,
	draftArchiveKey
} from './draft-persistence';
import { documentSetHash } from '$lib/domain/document-set';

const actor = { id: 'user_1', name: 'Yu Kimura', email: 'yu@example.test', type: 'user' as const };

describe('DraftPersistenceService', () => {
	it('persists and reads an instance-scoped, content-addressed Git archive', async () => {
		const envelopes = new MemoryEnvelopeStore(emptyEnvelope());
		const objects = new InMemoryObjectStore();
		const service = new DraftPersistenceService(
			envelopes,
			objects,
			new IsomorphicGitDraftRepository()
		);

		const result = await service.commit({
			envelopeId: 'env_1',
			expectedGeneration: 0,
			edits: [{ path: 'documents/agreement.md', content: '# Agreement' }],
			message: 'Create agreement',
			actor,
			idempotencyKey: 'draft-1',
			updatedAt: '2026-09-11T00:00:00.000Z'
		});

		const committed = result.revision;
		expect(result.outcome).toBe('committed');
		expect(committed.archiveKey).toBe(draftArchiveKey('env_1', committed.archiveSha256));
		expect(committed.archiveKey).toContain('/envelopes/env_1/sha256/');
		expect(committed.generation).toBe(1);
		expect(envelopes.lastPublication).toMatchObject({
			expectedGeneration: 0,
			resultingGeneration: 1,
			previousAuditHash: 'a'.repeat(64),
			auditEventHash: expect.stringMatching(/^[a-f0-9]{64}$/)
		});
		expect(JSON.parse(envelopes.lastPublication?.auditPayloadJson ?? '{}')).toEqual({
			generation: 1,
			commitSha: committed.commitSha,
			message: 'Create agreement',
			archiveSha256: committed.archiveSha256,
			changedPaths: ['documents/agreement.md', 'document-set.json'],
			provenance: { automationRunId: null, externalId: null },
			documentSetHash: expect.stringMatching(/^[a-f0-9]{64}$/)
		});
		expect(await service.readCurrent({ envelopeId: 'env_1' })).toMatchObject({
			generation: committed.generation,
			commitSha: committed.commitSha,
			archiveKey: committed.archiveKey,
			archiveSha256: committed.archiveSha256
		});
		await expect(service.readWorkspace({ envelopeId: 'env_1' })).resolves.toMatchObject({
			generation: 1,
			documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
			documentSet: {
				schema: 'signkit-document-set-v1',
				documents: [
					expect.objectContaining({
						kind: 'markdown',
						path: 'documents/agreement.md',
						position: 0
					})
				]
			}
		});
	});

	it('rejects a stale expected generation before creating an object', async () => {
		const envelope = emptyEnvelope({ repositoryGeneration: 2 });
		const objects = new InMemoryObjectStore();
		const repository = new CountingDraftRepository();
		const service = new DraftPersistenceService(
			new MemoryEnvelopeStore(envelope),
			objects,
			repository
		);

		await expect(
			service.commit({
				envelopeId: 'env_1',
				expectedGeneration: 1,
				edits: [{ path: 'documents/agreement.md', content: 'stale' }],
				message: 'Stale edit',
				actor,
				idempotencyKey: 'stale-1'
			})
		).rejects.toBeInstanceOf(DraftGenerationConflictError);
		expect(repository.commitCalls).toBe(0);
		expect(objects.size).toBe(0);
	});

	it('replays a completed command without creating another Git revision', async () => {
		const envelopes = new MemoryEnvelopeStore(emptyEnvelope());
		const objects = new InMemoryObjectStore();
		const service = new DraftPersistenceService(
			envelopes,
			objects,
			new IsomorphicGitDraftRepository()
		);
		const input = {
			envelopeId: 'env_1',
			expectedGeneration: 0,
			edits: [{ path: 'documents/agreement.md' as const, content: '# Agreement\r\n' }],
			message: ' Create agreement ',
			actor,
			idempotencyKey: 'replay-1',
			updatedAt: '2026-09-11T00:00:00.000Z'
		};

		const first = await service.commit(input);
		const replay = await service.commit({
			...input,
			edits: [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
			message: 'Create agreement'
		});

		expect(first.outcome).toBe('committed');
		expect(replay).toEqual({ outcome: 'replayed', revision: first.revision });
		expect(objects.size).toBe(1);
	});

	it('rejects reuse of an idempotency key for different normalized content', async () => {
		const objects = new InMemoryObjectStore();
		const service = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			objects,
			new IsomorphicGitDraftRepository()
		);
		const input = {
			envelopeId: 'env_1',
			expectedGeneration: 0,
			message: 'Create agreement',
			actor,
			idempotencyKey: 'conflict-1',
			updatedAt: '2026-09-11T00:00:00.000Z'
		};

		await service.commit({
			...input,
			edits: [{ path: 'documents/agreement.md', content: '# First' }]
		});
		await expect(
			service.commit({
				...input,
				edits: [{ path: 'documents/agreement.md', content: '# Different' }]
			})
		).rejects.toBeInstanceOf(DraftIdempotencyConflictError);
		expect(objects.size).toBe(1);
	});

	it('does not delete an orphaned immutable object after losing the pointer CAS', async () => {
		const envelopes = new MemoryEnvelopeStore(emptyEnvelope());
		envelopes.rejectCompareAndSet = true;
		const objects = new InMemoryObjectStore();
		const service = new DraftPersistenceService(
			envelopes,
			objects,
			new IsomorphicGitDraftRepository()
		);

		await expect(
			service.commit({
				envelopeId: 'env_1',
				expectedGeneration: 0,
				edits: [{ path: 'documents/agreement.md', content: '# Losing write' }],
				message: 'Concurrent edit',
				actor,
				idempotencyKey: 'losing-1'
			})
		).rejects.toBeInstanceOf(DraftGenerationConflictError);
		expect(objects.size).toBe(1);
		expect(objects.deleteCalls).toBe(0);
	});

	it('fails closed when stored archive bytes do not match the pointer SHA-256', async () => {
		const objects = new InMemoryObjectStore();
		const goodBytes = new TextEncoder().encode('good');
		const goodSha = await sha256Hex(goodBytes);
		const key = draftArchiveKey('env_1', goodSha);
		objects.seed(key, new TextEncoder().encode('tampered'), goodSha);
		const envelope = emptyEnvelope({
			repositoryGeneration: 1,
			repositoryHead: 'a'.repeat(40),
			repositoryArchiveKey: key,
			repositoryArchiveSha256: goodSha
		});
		const service = new DraftPersistenceService(
			new MemoryEnvelopeStore(envelope),
			objects,
			new CountingDraftRepository()
		);

		await expect(service.readCurrent({ envelopeId: 'env_1' })).rejects.toBeInstanceOf(
			DraftIntegrityError
		);
	});

	it('retries a read-only race and returns the newest stable pointer', async () => {
		const objects = new InMemoryObjectStore();
		const first = await persistedEnvelope(1, 'first', objects);
		const second = await persistedEnvelope(2, 'second', objects);
		const envelopes = new SequencedEnvelopeStore([first, second, second, second]);
		const service = new DraftPersistenceService(envelopes, objects, new CountingDraftRepository());

		const current = await service.readCurrent({ envelopeId: 'env_1' });

		expect(current.generation).toBe(2);
		if (current.archive !== null) {
			expect(new TextDecoder().decode(current.archive)).toBe('second');
		}
		expect(objects.getCalls).toBe(2);
	});

	it('accepts an uncertain immutable put only after verifying the stored bytes', async () => {
		const objects = new InMemoryObjectStore();
		objects.throwAfterNextPut = true;
		const service = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			objects,
			new IsomorphicGitDraftRepository()
		);

		const result = await service.commit({
			envelopeId: 'env_1',
			expectedGeneration: 0,
			edits: [{ path: 'documents/agreement.md', content: '# Durable' }],
			message: 'Durable write',
			actor,
			idempotencyKey: 'durable-1'
		});

		expect(result.revision.generation).toBe(1);
		expect(objects.getCalls).toBe(1);
	});

	it('independently verifies the repository-provided archive digest', async () => {
		const service = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			new InMemoryObjectStore(),
			new InvalidDigestDraftRepository()
		);

		await expect(
			service.commit({
				envelopeId: 'env_1',
				expectedGeneration: 0,
				edits: [{ path: 'documents/agreement.md', content: '# Invalid digest' }],
				message: 'Invalid digest',
				actor,
				idempotencyKey: 'invalid-digest-1'
			})
		).rejects.toBeInstanceOf(DraftIntegrityError);
	});

	it('binds documentSetHash in the revision audit payload to a recomputation from the workspace', async () => {
		const envelopes = new MemoryEnvelopeStore(emptyEnvelope());
		const service = new DraftPersistenceService(
			envelopes,
			new InMemoryObjectStore(),
			new IsomorphicGitDraftRepository()
		);
		await service.commit({
			envelopeId: 'env_1',
			expectedGeneration: 0,
			edits: [{ path: 'documents/agreement.md', content: '# Agreement' }],
			message: 'Create agreement',
			actor,
			idempotencyKey: 'hash-1',
			updatedAt: '2026-09-11T00:00:00.000Z'
		});
		const workspace = await service.readWorkspace({ envelopeId: 'env_1' });
		expect(workspace.documentSet).not.toBeNull();
		const payload = JSON.parse(envelopes.lastPublication?.auditPayloadJson ?? '{}') as {
			documentSetHash: string;
		};
		expect(payload.documentSetHash).toBe(await documentSetHash(workspace.documentSet!));
	});

	it('refuses a repository tree that does not match the document set', async () => {
		const service = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			new InMemoryObjectStore(),
			new ExtraPathDraftRepository()
		);
		await expect(
			service.commit({
				envelopeId: 'env_1',
				expectedGeneration: 0,
				edits: [{ path: 'documents/agreement.md', content: '# Agreement' }],
				message: 'Create agreement',
				actor,
				idempotencyKey: 'extra-path-1'
			})
		).rejects.toBeInstanceOf(DraftDocumentSetError);
	});

	it('appends a PDF leaf to an empty bundle, a Markdown-only bundle, and a bundle that already has a PDF', async () => {
		const firstDigest: string = 'c'.repeat(64);
		const secondDigest: string = 'd'.repeat(64);
		const uploaded = (): MemoryUploadedDocuments => {
			const store = new MemoryUploadedDocuments();
			store.add({
				envelopeId: 'env_1',
				sha256: firstDigest,
				objectKey: `uploaded/${firstDigest}.pdf`,
				byteSize: 4096,
				pageCount: 2,
				pageWidth: 595.28,
				pageHeight: 841.89,
				createdAt: '2026-09-11T00:00:00.000Z'
			});
			store.add({
				envelopeId: 'env_1',
				sha256: secondDigest,
				objectKey: `uploaded/${secondDigest}.pdf`,
				byteSize: 2048,
				pageCount: 1,
				pageWidth: 595.28,
				pageHeight: 841.89,
				createdAt: '2026-09-11T00:00:00.000Z'
			});
			return store;
		};
		const pdfLeaf = {
			op: 'appendPdf' as const,
			title: 'Schedule',
			sha256: firstDigest,
			byteSize: 4096,
			pageCount: 2,
			pageWidth: 595.28,
			pageHeight: 841.89
		};

		const emptyService = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			new InMemoryObjectStore(),
			new IsomorphicGitDraftRepository(),
			uploaded()
		);
		await emptyService.commit({
			envelopeId: 'env_1',
			expectedGeneration: 0,
			edits: [],
			message: 'Upload PDF Schedule',
			actor,
			idempotencyKey: 'pdf-empty',
			documentSet: pdfLeaf,
			updatedAt: '2026-09-11T00:00:00.000Z'
		});
		expect(
			(await emptyService.readWorkspace({ envelopeId: 'env_1' })).documentSet?.documents
		).toEqual([
			expect.objectContaining({ kind: 'pdf', title: 'Schedule', sha256: firstDigest, position: 0 })
		]);

		const mixedService = new DraftPersistenceService(
			new MemoryEnvelopeStore(emptyEnvelope()),
			new InMemoryObjectStore(),
			new IsomorphicGitDraftRepository(),
			uploaded()
		);
		await mixedService.commit({
			envelopeId: 'env_1',
			expectedGeneration: 0,
			edits: [{ path: 'documents/nda.md', content: '# NDA' }],
			message: 'Add NDA',
			actor,
			idempotencyKey: 'md-1',
			updatedAt: '2026-09-11T00:01:00.000Z'
		});
		await mixedService.commit({
			envelopeId: 'env_1',
			expectedGeneration: 1,
			edits: [],
			message: 'Upload PDF Schedule',
			actor,
			idempotencyKey: 'pdf-on-markdown',
			documentSet: pdfLeaf,
			updatedAt: '2026-09-11T00:02:00.000Z'
		});
		expect(
			(await mixedService.readWorkspace({ envelopeId: 'env_1' })).documentSet?.documents.map(
				(leaf) => leaf.kind
			)
		).toEqual(['markdown', 'pdf']);

		await mixedService.commit({
			envelopeId: 'env_1',
			expectedGeneration: 2,
			edits: [],
			message: 'Upload PDF Exhibit',
			actor,
			idempotencyKey: 'pdf-second',
			documentSet: {
				...pdfLeaf,
				title: 'Exhibit',
				sha256: secondDigest,
				byteSize: 2048,
				pageCount: 1
			},
			updatedAt: '2026-09-11T00:03:00.000Z'
		});
		expect(
			(await mixedService.readWorkspace({ envelopeId: 'env_1' })).documentSet?.documents.map(
				(leaf) => leaf.kind
			)
		).toEqual(['markdown', 'pdf', 'pdf']);
	});
});

class MemoryEnvelopeStore implements DraftMutationStore {
	rejectCompareAndSet = false;
	lastPublication: PublishDraftRevisionCommand | null = null;
	private readonly commands = new Map<
		string,
		{ requestFingerprint: string; envelopeId: string; revision: PublishedDraftRevision }
	>();

	constructor(private envelope: Envelope) {}

	async findEnvelope(envelopeId: string): Promise<Envelope | null> {
		if (this.envelope.id !== envelopeId) return null;
		return { ...this.envelope };
	}

	async compareAndSetDraftPointer(
		envelopeId: string,
		update: DraftPointerUpdate
	): Promise<boolean> {
		if (
			this.rejectCompareAndSet ||
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
			auditHead: {
				sequence: this.envelope.repositoryGeneration + 1,
				eventHash: 'a'.repeat(64)
			}
		};
	}

	async publishDraftRevision(
		command: PublishDraftRevisionCommand
	): Promise<PublishDraftRevisionResult> {
		this.lastPublication = command;
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
		if (
			this.rejectCompareAndSet ||
			this.envelope.repositoryGeneration !== command.expectedGeneration
		) {
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

class SequencedEnvelopeStore implements DraftMutationStore {
	private index = 0;

	constructor(private readonly envelopes: readonly Envelope[]) {}

	async findEnvelope(envelopeId: string): Promise<Envelope | null> {
		const envelope = this.envelopes[Math.min(this.index, this.envelopes.length - 1)];
		this.index += 1;
		if (envelope.id !== envelopeId) return null;
		return { ...envelope };
	}

	async compareAndSetDraftPointer(): Promise<boolean> {
		return false;
	}

	async transition(): Promise<boolean> {
		return false;
	}

	async prepareDraftRevision(): Promise<DraftRevisionPreparation> {
		throw new Error('Unexpected draft preparation');
	}

	async publishDraftRevision(): Promise<PublishDraftRevisionResult> {
		throw new Error('Unexpected draft publication');
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

function commandKey(key: DraftRevisionKey): string {
	return [key.actorType, key.actorId, key.idempotencyKey].join('\u0000');
}

class CountingDraftRepository implements DraftRepository {
	commitCalls = 0;

	async read(): Promise<readonly []> {
		return [];
	}

	async readManifest(): Promise<string | null> {
		return null;
	}

	async commit(): Promise<DraftVersion> {
		this.commitCalls += 1;
		throw new Error('Unexpected repository commit');
	}
}

class ExtraPathDraftRepository extends IsomorphicGitDraftRepository {
	override async commit(
		archive: Uint8Array | null,
		edits: readonly DraftEdit[],
		message: string,
		actor: DraftActor
	): Promise<DraftVersion> {
		const version: DraftVersion = await super.commit(archive, edits, message, actor);
		return { ...version, paths: [...version.paths, 'documents/ghost.md'] };
	}
}

class InvalidDigestDraftRepository implements DraftRepository {
	async read(): Promise<readonly []> {
		return [];
	}

	async readManifest(): Promise<string | null> {
		return null;
	}

	async commit(): Promise<DraftVersion> {
		return {
			commitSha: 'a'.repeat(40),
			archive: new TextEncoder().encode('archive'),
			archiveSha256: 'b'.repeat(64),
			paths: ['document-set.json', 'documents/agreement.md']
		};
	}
}

function emptyEnvelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		id: 'env_1',
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

async function persistedEnvelope(
	generation: number,
	content: string,
	objects: InMemoryObjectStore
): Promise<Envelope> {
	const archive = new TextEncoder().encode(content);
	const sha256 = await sha256Hex(archive);
	const key = draftArchiveKey('env_1', sha256);
	objects.seed(key, archive, sha256);
	return emptyEnvelope({
		repositoryGeneration: generation,
		repositoryHead: generation.toString(16).padStart(40, '0'),
		repositoryArchiveKey: key,
		repositoryArchiveSha256: sha256
	});
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number) =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

class MemoryUploadedDocuments implements EnvelopeUploadedDocumentStore {
	private readonly records = new Map<string, EnvelopeUploadedDocumentRecord>();

	add(record: EnvelopeUploadedDocumentRecord): void {
		this.records.set(record.sha256, record);
	}

	async insert(record: EnvelopeUploadedDocumentRecord): Promise<InsertUploadedDocumentResult> {
		if (this.records.has(record.sha256)) return 'duplicate';
		this.add(record);
		return 'inserted';
	}

	async find(__envelopeId: string, sha256: string): Promise<EnvelopeUploadedDocumentRecord | null> {
		return this.records.get(sha256) ?? null;
	}
}
