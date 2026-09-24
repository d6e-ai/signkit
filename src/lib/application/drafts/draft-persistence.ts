import { hashAuditEventV3 } from '$lib/domain/audit';
import { MAX_DRAFT_GENERATION, normalizeMarkdownContent } from '$lib/domain/draft';
import {
	appendPdfDocument,
	DOCUMENT_SET_MANIFEST_PATH,
	documentSetHash,
	DocumentSetError,
	materializeMarkdownLeaves,
	parseDocumentSet,
	reorderDocumentSet,
	serializeDocumentSet,
	upsertMarkdownDocument,
	type DocumentSetManifest,
	type DocumentSetLeaf
} from '$lib/domain/document-set';
import {
	assertDraftPath,
	isMarkdownPath,
	type Envelope,
	type MarkdownPath
} from '$lib/domain/envelope';
import { generateRevisionDiff, type RevisionDiffResult } from '$lib/domain/revision-diff';
import { isUuidV7, newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	DraftMutationStore,
	DraftRevisionKey,
	DraftRevisionPreparation,
	PersistedDraftRevisionLocator,
	PublishedDraftRevision,
	PublishDraftRevisionResult
} from '$lib/ports/draft-mutation-store';
import type {
	DraftActor,
	DraftCommitOptions,
	DraftDocument,
	DraftEdit,
	DraftRepository,
	DraftVersion
} from '$lib/ports/draft-repository';
import type { EnvelopeUploadedDocumentStore } from '$lib/ports/envelope-uploaded-document-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';

const ARCHIVE_CONTENT_TYPE = 'application/vnd.signkit.git-archive+gzip';
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_CURRENT_READ_ATTEMPTS = 3;
const MAX_DRAFT_EDITS = 50;
const MAX_DRAFT_CONTENT_BYTES = 512 * 1024;
const MAX_DRAFT_TOTAL_CONTENT_BYTES = 1024 * 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 200;
const MAX_PROVENANCE_VALUE_LENGTH = 200;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const NUL_CHARACTER = '\x00';

export interface ReadCurrentDraftInput {
	envelopeId: string;
}

export type DocumentSetMutation =
	| {
			op: 'appendPdf';
			title: string;
			sha256: string;
			byteSize: number;
			pageCount: number;
			pageWidth: number;
			pageHeight: number;
			position?: number;
	  }
	| { op: 'reorder'; documentIds: readonly string[] };

export interface CommitDraftInput extends ReadCurrentDraftInput {
	expectedGeneration: number;
	edits: readonly DraftEdit[];
	message: string;
	actor: DraftActor;
	idempotencyKey: string;
	provenance?: DraftCommitProvenance;
	updatedAt?: string;
	documentSet?: DocumentSetMutation;
}

export interface DraftCommitProvenance {
	automationRunId?: string;
	externalId?: string;
}

export type CommitDraftResult =
	| { outcome: 'committed'; revision: PublishedDraftRevision }
	| { outcome: 'replayed'; revision: PublishedDraftRevision };

export interface EmptyDraftSnapshot {
	generation: 0;
	commitSha: null;
	archiveKey: null;
	archiveSha256: null;
	archive: null;
}

export interface PersistedDraftSnapshot {
	generation: number;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
	archive: Uint8Array;
}

export type DraftSnapshot = EmptyDraftSnapshot | PersistedDraftSnapshot;

export interface DraftWorkspaceSnapshot {
	generation: number;
	commitSha: string | null;
	archiveKey: string | null;
	archiveSha256: string | null;
	documents: readonly DraftDocument[];
	documentSet: DocumentSetManifest | null;
}

export interface ImmutableDraftRevision {
	envelopeId: string;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
}

/** Archive bytes already scope-checked and SHA-256-verified against `archiveKey`. */
export interface VerifiedImmutableDraftRevision {
	documents: readonly DraftDocument[];
	archive: Uint8Array;
}

export class DraftEnvelopeNotFoundError extends Error {
	readonly code = 'DRAFT_ENVELOPE_NOT_FOUND';

	constructor() {
		super('Draft envelope was not found');
		this.name = 'DraftEnvelopeNotFoundError';
	}
}

export class DraftGenerationConflictError extends Error {
	readonly code = 'DRAFT_GENERATION_CONFLICT';

	constructor(readonly expectedGeneration: number) {
		super(`Draft generation ${expectedGeneration} is no longer current`);
		this.name = 'DraftGenerationConflictError';
	}
}

export class DraftIdempotencyConflictError extends Error {
	readonly code = 'DRAFT_IDEMPOTENCY_CONFLICT';

	constructor() {
		super('The idempotency key was already used for a different draft command');
		this.name = 'DraftIdempotencyConflictError';
	}
}

export class DraftEnvelopeImmutableError extends Error {
	readonly code = 'DRAFT_ENVELOPE_IMMUTABLE';

	constructor() {
		super('Only draft envelopes can accept document revisions');
		this.name = 'DraftEnvelopeImmutableError';
	}
}

export class DraftIntegrityError extends Error {
	readonly code = 'DRAFT_INTEGRITY_ERROR';

	constructor(message: string) {
		super(message);
		this.name = 'DraftIntegrityError';
	}
}

export class DraftReadConflictError extends Error {
	readonly code = 'DRAFT_READ_CONFLICT';

	constructor() {
		super('Draft changed repeatedly while it was being read');
		this.name = 'DraftReadConflictError';
	}
}

export class DraftDocumentSetError extends Error {
	readonly code = 'DRAFT_DOCUMENT_SET_CONFLICT';

	constructor(message: string = 'The draft document set does not match its Git tree') {
		super(message);
		this.name = 'DraftDocumentSetError';
	}
}

export class DraftRevisionNotFoundError extends Error {
	readonly code = 'DRAFT_REVISION_NOT_FOUND';

	constructor(message: string = 'Draft revision was not found') {
		super(message);
		this.name = 'DraftRevisionNotFoundError';
	}
}

export class DraftDocumentNotFoundError extends Error {
	readonly code = 'DRAFT_DOCUMENT_NOT_FOUND';

	constructor(message: string = 'Document was not found in this revision') {
		super(message);
		this.name = 'DraftDocumentNotFoundError';
	}
}

export interface DraftRevisionMetadata {
	generation: number;
	commitSha: string;
	timestamp: string;
	message: string;
	actorType: 'user' | 'agent' | 'system';
	provenance?: DraftCommitProvenance;
}

export interface DraftRevisionHistoryPage {
	revisions: readonly DraftRevisionMetadata[];
	truncated: boolean;
	nextCursor?: number | null;
}

export interface DraftExactRevision {
	generation: number;
	commitSha: string;
	archiveSha256: string;
	timestamp: string;
	message: string;
	actorType: 'user' | 'agent' | 'system';
	provenance?: DraftCommitProvenance;
	documentSet: DocumentSetManifest | null;
	documents: readonly DraftDocument[];
	selectedDocument?: DraftDocument;
}

export interface ListDraftRevisionsInput {
	envelopeId: string;
	limit?: number;
	cursor?: number;
}

export interface ReadExactDraftRevisionInput {
	envelopeId: string;
	revisionRef: string;
	path?: string;
}

export interface DiffDraftRevisionsInput {
	envelopeId: string;
	baseRef?: string;
	headRef?: string;
	includeUnified?: boolean;
}

/**
 * Coordinates the mutable Git archive with an immutable object store and the
 * database's atomic publication of the envelope pointer, idempotency result,
 * and audit event. Object writes happen first. A failed publication therefore
 * leaves an unreferenced, content-addressed object; it must not be deleted on
 * the request path because another writer may have published the same object.
 */
export class DraftPersistenceService {
	constructor(
		private readonly store: DraftMutationStore,
		private readonly objects: ObjectStore,
		private readonly repository: DraftRepository,
		private readonly uploadedDocuments: Pick<EnvelopeUploadedDocumentStore, 'find'> | null = null,
		private readonly newId: UuidV7Generator = newUuidV7
	) {}

	async readCurrent(input: ReadCurrentDraftInput): Promise<DraftSnapshot> {
		assertScopedIdentifier(input.envelopeId, 'envelope');

		for (let attempt = 0; attempt < MAX_CURRENT_READ_ATTEMPTS; attempt += 1) {
			const before = await this.findEnvelope(input.envelopeId);
			const snapshot = await this.loadSnapshot(before);
			const after = await this.findEnvelope(input.envelopeId);

			if (sameDraftPointer(before, after)) return snapshot;
		}

		throw new DraftReadConflictError();
	}

	async readWorkspace(input: ReadCurrentDraftInput): Promise<DraftWorkspaceSnapshot> {
		const snapshot: DraftSnapshot = await this.readCurrent(input);
		const documents: readonly DraftDocument[] = await this.repository.read(
			snapshot.archive,
			snapshot.commitSha
		);
		const documentSet: DocumentSetManifest | null = await this.loadDocumentSet(
			snapshot.archive,
			snapshot.commitSha
		);
		return {
			generation: snapshot.generation,
			commitSha: snapshot.commitSha,
			archiveKey: snapshot.archiveKey,
			archiveSha256: snapshot.archiveSha256,
			documents,
			documentSet
		};
	}

	async listRevisions(input: ListDraftRevisionsInput): Promise<DraftRevisionHistoryPage> {
		assertScopedIdentifier(input.envelopeId, 'envelope');
		await this.findEnvelope(input.envelopeId);

		const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
		const locators = await this.store.listDraftRevisionLocators(input.envelopeId, {
			limit: limit + 1,
			cursor: input.cursor
		});

		const truncated = locators.length > limit;
		const pageLocators = locators.slice(0, limit);
		const nextCursor = truncated ? pageLocators[pageLocators.length - 1].generation : null;

		const revisions: DraftRevisionMetadata[] = [];
		for (const locator of pageLocators) {
			const listed = extractListedRevisionMetadata(locator);
			if (listed !== null) {
				revisions.push({
					generation: locator.generation,
					commitSha: locator.commitSha,
					timestamp: locator.updatedAt,
					message: listed.message,
					actorType: locator.actorType,
					provenance: listed.provenance ?? undefined
				});
				continue;
			}
			// Commits published before the audited message field existed still
			// obtain their message from the verified immutable Git archive.
			const verified = await this.loadVerifiedRevisionLocator(input.envelopeId, locator);
			revisions.push({
				generation: verified.generation,
				commitSha: verified.commitSha,
				timestamp: verified.timestamp,
				message: verified.message,
				actorType: verified.actorType,
				provenance: verified.provenance
			});
		}

		return {
			revisions,
			truncated,
			nextCursor
		};
	}

	async readRevision(input: ReadExactDraftRevisionInput): Promise<DraftExactRevision> {
		assertScopedIdentifier(input.envelopeId, 'envelope');
		await this.findEnvelope(input.envelopeId);

		const ref = parseRevisionReference(input.revisionRef);
		let locator: PersistedDraftRevisionLocator | null;
		if (ref.kind === 'generation') {
			locator = await this.store.findDraftRevisionLocatorByGeneration(input.envelopeId, ref.value);
		} else {
			locator = await this.store.findDraftRevisionLocatorByCommit(input.envelopeId, ref.value);
		}

		if (locator === null) {
			throw new DraftRevisionNotFoundError();
		}

		const verified = await this.loadVerifiedRevisionLocator(input.envelopeId, locator);
		let selectedDocument: DraftDocument | undefined;
		if (input.path !== undefined) {
			assertDraftPath(input.path);
			const found = verified.documents.find((d) => d.path === input.path);
			if (!found) {
				throw new DraftDocumentNotFoundError();
			}
			selectedDocument = found;
		}

		return {
			generation: verified.generation,
			commitSha: verified.commitSha,
			archiveSha256: verified.archiveSha256,
			timestamp: verified.timestamp,
			message: verified.message,
			actorType: verified.actorType,
			provenance: verified.provenance,
			documentSet: verified.documentSet,
			documents: verified.documents,
			selectedDocument
		};
	}

	async diffRevisions(input: DiffDraftRevisionsInput): Promise<RevisionDiffResult> {
		assertScopedIdentifier(input.envelopeId, 'envelope');
		const envelope = await this.findEnvelope(input.envelopeId);

		// Resolve head revision
		let headData: {
			generation: number;
			commitSha: string | null;
			message: string | null;
			documentSet: DocumentSetManifest | null;
			documents: readonly DraftDocument[];
		};

		if (input.headRef !== undefined) {
			const headRef = parseRevisionReference(input.headRef);
			let locator: PersistedDraftRevisionLocator | null = null;
			if (headRef.kind === 'generation') {
				if (headRef.value === 0) {
					headData = {
						generation: 0,
						commitSha: null,
						message: null,
						documentSet: null,
						documents: []
					};
				} else {
					locator = await this.store.findDraftRevisionLocatorByGeneration(
						input.envelopeId,
						headRef.value
					);
				}
			} else {
				locator = await this.store.findDraftRevisionLocatorByCommit(
					input.envelopeId,
					headRef.value
				);
			}

			if (locator !== null) {
				const verified = await this.loadVerifiedRevisionLocator(input.envelopeId, locator);
				headData = {
					generation: verified.generation,
					commitSha: verified.commitSha,
					message: verified.message,
					documentSet: verified.documentSet,
					documents: verified.documents
				};
			} else if (!headData!) {
				throw new DraftRevisionNotFoundError('Head revision not found');
			}
		} else {
			if (envelope.repositoryGeneration === 0) {
				headData = {
					generation: 0,
					commitSha: null,
					message: null,
					documentSet: null,
					documents: []
				};
			} else {
				const locator = await this.store.findDraftRevisionLocatorByGeneration(
					input.envelopeId,
					envelope.repositoryGeneration
				);
				if (locator === null) {
					throw new DraftRevisionNotFoundError('Current draft revision not found');
				}
				const verified = await this.loadVerifiedRevisionLocator(input.envelopeId, locator);
				headData = {
					generation: verified.generation,
					commitSha: verified.commitSha,
					message: verified.message,
					documentSet: verified.documentSet,
					documents: verified.documents
				};
			}
		}

		// Resolve base revision
		let baseData: {
			generation: number;
			commitSha: string | null;
			documentSet: DocumentSetManifest | null;
			documents: readonly DraftDocument[];
		};

		if (input.baseRef !== undefined) {
			const baseRef = parseRevisionReference(input.baseRef);
			let locator: PersistedDraftRevisionLocator | null = null;
			if (baseRef.kind === 'generation') {
				if (baseRef.value === 0) {
					baseData = {
						generation: 0,
						commitSha: null,
						documentSet: null,
						documents: []
					};
				} else {
					locator = await this.store.findDraftRevisionLocatorByGeneration(
						input.envelopeId,
						baseRef.value
					);
				}
			} else {
				locator = await this.store.findDraftRevisionLocatorByCommit(
					input.envelopeId,
					baseRef.value
				);
			}

			if (locator !== null) {
				const verified = await this.loadVerifiedRevisionLocator(input.envelopeId, locator);
				baseData = {
					generation: verified.generation,
					commitSha: verified.commitSha,
					documentSet: verified.documentSet,
					documents: verified.documents
				};
			} else if (!baseData!) {
				throw new DraftRevisionNotFoundError('Base revision not found');
			}
		} else {
			const targetBaseGen = Math.max(0, headData.generation - 1);
			if (targetBaseGen === 0) {
				baseData = {
					generation: 0,
					commitSha: null,
					documentSet: null,
					documents: []
				};
			} else {
				const locator = await this.store.findDraftRevisionLocatorByGeneration(
					input.envelopeId,
					targetBaseGen
				);
				if (locator === null) {
					throw new DraftRevisionNotFoundError('Base revision not found');
				}
				const verified = await this.loadVerifiedRevisionLocator(input.envelopeId, locator);
				baseData = {
					generation: verified.generation,
					commitSha: verified.commitSha,
					documentSet: verified.documentSet,
					documents: verified.documents
				};
			}
		}

		return generateRevisionDiff({
			base: {
				generation: baseData.generation,
				commitSha: baseData.commitSha,
				manifest: baseData.documentSet,
				documents: new Map(baseData.documents.map((d) => [d.path, d.content]))
			},
			head: {
				generation: headData.generation,
				commitSha: headData.commitSha,
				message: headData.message,
				manifest: headData.documentSet,
				documents: new Map(headData.documents.map((d) => [d.path, d.content]))
			},
			options: {
				includeUnified: input.includeUnified ?? true
			}
		});
	}

	private async loadVerifiedRevisionLocator(
		envelopeId: string,
		locator: PersistedDraftRevisionLocator
	): Promise<{
		generation: number;
		commitSha: string;
		archiveSha256: string;
		timestamp: string;
		message: string;
		actorType: 'user' | 'agent' | 'system';
		provenance?: DraftCommitProvenance;
		documentSet: DocumentSetManifest | null;
		documents: readonly DraftDocument[];
		archive: Uint8Array;
	}> {
		if (!GIT_SHA_PATTERN.test(locator.commitSha)) {
			throw new DraftIntegrityError('Stored draft command has an invalid Git commit SHA');
		}
		assertSha256(locator.archiveSha256);
		const expectedKey = draftArchiveKey(envelopeId, locator.archiveSha256);
		if (locator.archiveKey !== expectedKey) {
			throw new DraftIntegrityError('Stored draft command has an invalid archive key');
		}

		const archive = await this.readVerifiedArchive(locator.archiveKey, locator.archiveSha256);

		let documents: readonly DraftDocument[];
		let documentSet: DocumentSetManifest | null = null;
		let message = '';

		if (typeof this.repository.readRevisionSnapshot === 'function') {
			const snapshot = await this.repository.readRevisionSnapshot(archive, locator.commitSha);
			if (snapshot === null) {
				throw new DraftIntegrityError('Pinned draft repository failed Git verification');
			}
			documents = snapshot.documents;
			message = snapshot.message;
			if (snapshot.manifest !== null) {
				try {
					documentSet = parseDocumentSet(snapshot.manifest);
				} catch {
					throw new DraftIntegrityError('Pinned document set is invalid');
				}
			} else if (documents.length > 0) {
				documentSet = await this.materializeFromMarkdown(
					new Map(documents.map((d): [MarkdownPath, string] => [d.path, d.content]))
				);
			}
		} else {
			try {
				documents = await this.repository.read(archive, locator.commitSha);
			} catch {
				throw new DraftIntegrityError('Pinned draft repository failed Git verification');
			}
			documentSet = await this.loadDocumentSet(archive, locator.commitSha);
			if (documentSet === null && documents.length > 0) {
				documentSet = await this.materializeFromMarkdown(
					new Map(documents.map((d): [MarkdownPath, string] => [d.path, d.content]))
				);
			}
			if (typeof this.repository.readCommitMessage === 'function') {
				message = (await this.repository.readCommitMessage(archive, locator.commitSha)) ?? '';
			}
		}

		const provenance = extractAllowlistedProvenance(locator.auditPayloadJson);

		return {
			generation: locator.generation,
			commitSha: locator.commitSha,
			archiveSha256: locator.archiveSha256,
			timestamp: locator.updatedAt,
			message,
			actorType: locator.actorType,
			provenance: provenance ?? undefined,
			documentSet,
			documents,
			archive
		};
	}

	async commit(input: CommitDraftInput): Promise<CommitDraftResult> {
		assertScopedIdentifier(input.envelopeId, 'envelope');
		assertScopedIdentifier(input.actor.id, 'actor');
		assertGeneration(input.expectedGeneration);
		if (input.expectedGeneration >= MAX_DRAFT_GENERATION) {
			throw new Error('Draft generation cannot be incremented within the portable database range');
		}
		const canonical = canonicalizeCommitInput(input);
		const requestFingerprint: string = await sha256Text(
			JSON.stringify({
				envelopeId: input.envelopeId,
				expectedGeneration: input.expectedGeneration,
				message: canonical.message,
				edits: canonical.markdownEdits,
				provenance: canonical.provenance,
				documentSet: canonical.documentSet
			})
		);
		const key: DraftRevisionKey = {
			envelopeId: input.envelopeId,
			actorType: input.actor.type,
			actorId: input.actor.id,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};
		const preparation: DraftRevisionPreparation = await this.store.prepareDraftRevision(
			key,
			input.expectedGeneration
		);
		if (preparation.outcome === 'replayed') {
			await this.verifyPublishedRevision(input, preparation.revision);
			return { outcome: 'replayed', revision: preparation.revision };
		}
		throwForPreparationFailure(preparation, input.expectedGeneration);
		if (preparation.outcome !== 'ready') {
			throw new DraftIntegrityError('Draft preparation returned an unsupported outcome');
		}
		if (preparation.envelope.id !== input.envelopeId) {
			throw new DraftIntegrityError('Draft preparation crossed its envelope scope');
		}
		if (preparation.envelope.status !== 'draft') throw new DraftEnvelopeImmutableError();
		if (preparation.envelope.repositoryGeneration !== input.expectedGeneration) {
			throw new DraftGenerationConflictError(input.expectedGeneration);
		}
		if (
			!Number.isSafeInteger(preparation.auditHead.sequence) ||
			preparation.auditHead.sequence < 1
		) {
			throw new DraftIntegrityError('Draft audit head sequence is invalid');
		}
		assertSha256(preparation.auditHead.eventHash);

		const current = await this.loadSnapshot(preparation.envelope);
		const next = await this.buildDocumentSetCommit(input, current, canonical);
		const commitOptions: DraftCommitOptions = { replaceTrackedPaths: true };
		const version = await this.repository.commit(
			current.archive,
			next.edits,
			canonical.message,
			input.actor,
			commitOptions
		);
		await this.assertResultingDocumentSet(
			input.envelopeId,
			version.paths,
			next.manifest,
			next.markdownByPath
		);
		const archiveSha256: string = await verifyRepositoryVersion(version);
		const archiveKey: string = draftArchiveKey(input.envelopeId, archiveSha256);

		await this.persistImmutableArchive(archiveKey, version.archive, archiveSha256);

		const nextGeneration: number = input.expectedGeneration + 1;
		assertGeneration(nextGeneration);
		const updatedAt: string = input.updatedAt ?? new Date().toISOString();
		assertIsoTimestamp(updatedAt);
		const auditSequence: number = preparation.auditHead.sequence + 1;
		if (!Number.isSafeInteger(auditSequence) || auditSequence < 2) {
			throw new DraftIntegrityError('Draft audit sequence is invalid');
		}
		const auditPayload = {
			generation: nextGeneration,
			commitSha: version.commitSha,
			message: canonical.message,
			archiveSha256,
			changedPaths: next.edits.map((edit: DraftEdit): string => edit.path),
			provenance: canonical.provenance,
			documentSetHash: await documentSetHash(next.manifest)
		};
		const auditPayloadJson: string = JSON.stringify(auditPayload);
		// The durable command row binds this event to the idempotency key and
		// request fingerprint, so the identifier itself is minted rather than
		// derived from the key.
		const auditEventId: string = this.newId();
		const auditEventHash: string = await hashAuditEventV3(
			{
				sequence: auditSequence,
				eventType: 'draft.revision_created',
				actorType: input.actor.type,
				actorId: input.actor.id,
				occurredAt: updatedAt,
				payload: auditPayload,
				previousHash: preparation.auditHead.eventHash
			},
			{ envelopeId: input.envelopeId }
		);
		const publication: PublishDraftRevisionResult = await this.store.publishDraftRevision({
			...key,
			expectedGeneration: input.expectedGeneration,
			resultingGeneration: nextGeneration,
			commitSha: version.commitSha,
			archiveKey,
			archiveSha256,
			updatedAt,
			expectedAuditSequence: preparation.auditHead.sequence,
			previousAuditHash: preparation.auditHead.eventHash,
			auditEventId,
			auditEventHash,
			auditPayloadJson
		});

		if (publication.outcome === 'published') {
			return { outcome: 'committed', revision: publication.revision };
		}
		if (publication.outcome === 'replayed') {
			await this.verifyPublishedRevision(input, publication.revision);
			return { outcome: 'replayed', revision: publication.revision };
		}
		throwForPublicationFailure(publication, input.expectedGeneration);
		throw new DraftIntegrityError('Draft publication returned an unsupported outcome');
	}

	private async loadDocumentSet(
		archive: Uint8Array | null,
		commitSha: string | null
	): Promise<DocumentSetManifest | null> {
		if (typeof this.repository.readManifest !== 'function') return null;
		const manifestJson: string | null = await this.repository.readManifest(archive, commitSha);
		if (manifestJson === null) return null;
		try {
			return parseDocumentSet(manifestJson);
		} catch {
			throw new DraftIntegrityError('Pinned document set is invalid');
		}
	}

	private async buildDocumentSetCommit(
		input: CommitDraftInput,
		current: DraftSnapshot,
		canonical: CanonicalDraftCommitInput
	): Promise<{
		manifest: DocumentSetManifest;
		edits: readonly DraftEdit[];
		markdownByPath: Map<MarkdownPath, string>;
	}> {
		const currentDocuments: readonly DraftDocument[] = await this.repository.read(
			current.archive,
			current.commitSha
		);
		const currentManifest: DocumentSetManifest | null = await this.loadDocumentSet(
			current.archive,
			current.commitSha
		);
		const markdownByPath: Map<MarkdownPath, string> = new Map(
			currentDocuments.map((document: DraftDocument): [MarkdownPath, string] => [
				document.path,
				document.content
			])
		);
		for (const edit of canonical.markdownEdits) {
			if (!isMarkdownPath(edit.path)) {
				throw new Error('Draft commits accept Markdown files under documents/ only');
			}
			markdownByPath.set(edit.path, edit.content);
		}

		let manifest: DocumentSetManifest;
		try {
			if (canonical.documentSet?.op === 'reorder') {
				if (currentManifest === null) {
					throw new DraftDocumentSetError('The draft has no document set to reorder');
				}
				manifest = reorderDocumentSet(currentManifest, canonical.documentSet.documentIds);
				const keep: Set<string> = new Set(
					manifest.documents.flatMap((leaf: DocumentSetLeaf): string[] =>
						leaf.kind === 'markdown' ? [leaf.path] : []
					)
				);
				for (const path of [...markdownByPath.keys()]) {
					if (!keep.has(path)) markdownByPath.delete(path);
				}
			} else if (canonical.documentSet?.op === 'appendPdf') {
				const base: DocumentSetManifest | null =
					currentManifest ??
					(markdownByPath.size > 0 ? await this.materializeFromMarkdown(markdownByPath) : null);
				manifest = appendPdfDocument(
					base,
					{
						title: canonical.documentSet.title,
						sha256: canonical.documentSet.sha256,
						byteSize: canonical.documentSet.byteSize,
						pageCount: canonical.documentSet.pageCount,
						pageWidth: canonical.documentSet.pageWidth,
						pageHeight: canonical.documentSet.pageHeight,
						position: canonical.documentSet.position
					},
					this.newId
				);
			} else if (currentManifest === null) {
				manifest = await this.materializeFromMarkdown(markdownByPath);
			} else {
				manifest = currentManifest;
				for (const edit of canonical.markdownEdits) {
					if (!isMarkdownPath(edit.path)) continue;
					manifest = upsertMarkdownDocument(
						manifest,
						edit.path,
						await sha256Text(edit.content),
						this.newId
					);
				}
			}

			const keepMarkdown: Set<string> = new Set(
				manifest.documents.flatMap((leaf: DocumentSetLeaf): string[] =>
					leaf.kind === 'markdown' ? [leaf.path] : []
				)
			);
			for (const path of [...markdownByPath.keys()]) {
				if (!keepMarkdown.has(path)) markdownByPath.delete(path);
			}

			const edits: DraftEdit[] = [
				...[...markdownByPath.entries()]
					.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
					.map(([path, content]: [MarkdownPath, string]): DraftEdit => ({
						path,
						content
					})),
				{ path: DOCUMENT_SET_MANIFEST_PATH, content: serializeDocumentSet(manifest) }
			];
			void input;
			return { manifest, edits, markdownByPath };
		} catch (error: unknown) {
			if (error instanceof DraftDocumentSetError) throw error;
			if (error instanceof DocumentSetError) {
				throw new DraftDocumentSetError(error.message);
			}
			throw error;
		}
	}

	private async materializeFromMarkdown(
		markdownByPath: Map<MarkdownPath, string>
	): Promise<DocumentSetManifest> {
		if (markdownByPath.size < 1) {
			throw new DraftDocumentSetError('A document set must contain at least one document');
		}
		const paths: MarkdownPath[] = [...markdownByPath.keys()];
		const contentSha256ByPath: Map<string, string> = new Map();
		for (const [path, content] of markdownByPath) {
			contentSha256ByPath.set(path, await sha256Text(content));
		}
		return materializeMarkdownLeaves(paths, contentSha256ByPath, this.newId);
	}

	private async assertResultingDocumentSet(
		envelopeId: string,
		paths: readonly string[],
		manifest: DocumentSetManifest,
		markdownByPath: Map<MarkdownPath, string>
	): Promise<void> {
		const tracked: string[] = [...paths].sort();
		const markdownPaths: MarkdownPath[] = manifest.documents.flatMap(
			(leaf: DocumentSetLeaf): MarkdownPath[] => (leaf.kind === 'markdown' ? [leaf.path] : [])
		);
		const expected: string[] = [...markdownPaths, DOCUMENT_SET_MANIFEST_PATH].sort();
		if (
			tracked.length !== expected.length ||
			tracked.some((path, index) => path !== expected[index])
		) {
			throw new DraftDocumentSetError('The Git tree does not match the document set manifest');
		}
		for (const leaf of manifest.documents) {
			if (leaf.kind !== 'markdown') continue;
			const content: string | undefined = markdownByPath.get(leaf.path);
			if (content === undefined) {
				throw new DraftDocumentSetError(
					'The document set names a Markdown path that is not tracked'
				);
			}
			if ((await sha256Text(content)) !== leaf.contentSha256) {
				throw new DraftDocumentSetError('Markdown contentSha256 does not match the tracked bytes');
			}
		}
		for (const leaf of manifest.documents) {
			if (leaf.kind !== 'pdf') continue;
			if (this.uploadedDocuments === null) {
				throw new DraftDocumentSetError('Uploaded PDF bytes are not bound to this envelope');
			}
			const record = await this.uploadedDocuments.find(envelopeId, leaf.sha256);
			if (record === null) {
				throw new DraftDocumentSetError('Uploaded PDF digest is missing from the envelope ledger');
			}
		}
		void markdownByPath;
	}

	private async findEnvelope(envelopeId: string): Promise<Envelope> {
		const envelope = await this.store.findEnvelope(envelopeId);
		if (!envelope) throw new DraftEnvelopeNotFoundError();
		return envelope;
	}

	private async verifyPublishedRevision(
		input: CommitDraftInput,
		revision: PublishedDraftRevision
	): Promise<void> {
		if (revision.generation !== input.expectedGeneration + 1) {
			throw new DraftIntegrityError('Stored draft command has an invalid generation');
		}
		if (!GIT_SHA_PATTERN.test(revision.commitSha)) {
			throw new DraftIntegrityError('Stored draft command has an invalid Git commit SHA');
		}
		assertIsoTimestamp(revision.updatedAt);
		// The store already proved this row belongs to the same idempotency key,
		// actor, envelope, and request fingerprint; what remains to check here is
		// that the recorded identifier is a canonical SignKit UUIDv7.
		if (!isUuidV7(revision.auditEventId)) {
			throw new DraftIntegrityError('Stored draft command has an invalid audit event ID');
		}
		assertSha256(revision.archiveSha256);
		const expectedKey: string = draftArchiveKey(input.envelopeId, revision.archiveSha256);
		if (revision.archiveKey !== expectedKey) {
			throw new DraftIntegrityError('Stored draft command has an invalid archive key');
		}
		await readImmutableDraftRevision(
			{
				envelopeId: input.envelopeId,
				commitSha: revision.commitSha,
				archiveKey: revision.archiveKey,
				archiveSha256: revision.archiveSha256
			},
			this.objects,
			this.repository
		);
	}

	private async loadSnapshot(envelope: Envelope): Promise<DraftSnapshot> {
		assertGeneration(envelope.repositoryGeneration);

		if (envelope.repositoryGeneration === 0) {
			if (
				envelope.repositoryHead !== null ||
				envelope.repositoryArchiveKey !== null ||
				envelope.repositoryArchiveSha256 !== null
			) {
				throw new DraftIntegrityError('Empty draft has a partial repository pointer');
			}

			return {
				generation: 0,
				commitSha: null,
				archiveKey: null,
				archiveSha256: null,
				archive: null
			};
		}

		const commitSha = envelope.repositoryHead;
		const archiveKey = envelope.repositoryArchiveKey;
		const archiveSha256 = envelope.repositoryArchiveSha256;
		if (!commitSha || !archiveKey || !archiveSha256) {
			throw new DraftIntegrityError('Persisted draft has an incomplete repository pointer');
		}
		if (!GIT_SHA_PATTERN.test(commitSha)) {
			throw new DraftIntegrityError('Persisted draft has an invalid Git commit SHA');
		}
		assertSha256(archiveSha256);

		const expectedKey = draftArchiveKey(envelope.id, archiveSha256);
		if (archiveKey !== expectedKey) {
			throw new DraftIntegrityError('Draft archive key does not match its envelope scope');
		}

		const archive = await this.readVerifiedArchive(archiveKey, archiveSha256);
		return {
			generation: envelope.repositoryGeneration,
			commitSha,
			archiveKey,
			archiveSha256,
			archive
		};
	}

	private async persistImmutableArchive(
		key: string,
		archive: Uint8Array,
		archiveSha256: string
	): Promise<void> {
		if (archive.byteLength > MAX_ARCHIVE_BYTES) {
			throw new DraftIntegrityError('Draft repository archive exceeds the size limit');
		}

		try {
			const stored = await this.objects.putImmutable(key, {
				contentType: ARCHIVE_CONTENT_TYPE,
				body: archive,
				sha256: archiveSha256,
				metadata: { format: 'signkit-git-archive-v1' }
			});
			assertStoredMetadata(stored, key, archive.byteLength, archiveSha256);
		} catch (error: unknown) {
			// A provider can report a precondition failure, or lose the response after
			// accepting the write. Reuse is safe only after reading and hashing the
			// immutable object ourselves. Any other failure remains fatal.
			try {
				await this.readVerifiedArchive(key, archiveSha256);
				return;
			} catch {
				throw error;
			}
		}
	}

	private async readVerifiedArchive(key: string, expectedSha256: string): Promise<Uint8Array> {
		const stream = await this.objects.get(key);
		if (!stream) throw new DraftIntegrityError('Draft repository archive is missing');
		const archive = await readStreamBounded(stream, MAX_ARCHIVE_BYTES);
		const actualSha256 = await sha256Hex(archive);
		if (actualSha256 !== expectedSha256) {
			throw new DraftIntegrityError('Draft repository archive failed SHA-256 verification');
		}
		return archive;
	}
}

/**
 * Read one content-addressed Git revision without consulting the mutable
 * envelope pointer. Callers must obtain this locator from a trusted database
 * boundary; no client-supplied key or commit is accepted here.
 */
export async function readImmutableDraftRevision(
	revision: ImmutableDraftRevision,
	objects: ObjectStore,
	repository: DraftRepository
): Promise<VerifiedImmutableDraftRevision> {
	if (!GIT_SHA_PATTERN.test(revision.commitSha)) {
		throw new DraftIntegrityError('Pinned draft revision has an invalid Git commit SHA');
	}
	assertSha256(revision.archiveSha256);
	const expectedKey: string = draftArchiveKey(revision.envelopeId, revision.archiveSha256);
	if (revision.archiveKey !== expectedKey) {
		throw new DraftIntegrityError('Pinned draft archive key does not match its envelope scope');
	}
	const stream: ReadableStream<Uint8Array> | null = await objects.get(revision.archiveKey);
	if (stream === null) throw new DraftIntegrityError('Pinned draft repository archive is missing');
	const archive: Uint8Array = await readStreamBounded(stream, MAX_ARCHIVE_BYTES);
	const actualSha256: string = await sha256Hex(archive);
	if (actualSha256 !== revision.archiveSha256) {
		throw new DraftIntegrityError('Pinned draft repository archive failed SHA-256 verification');
	}
	try {
		return { documents: await repository.read(archive, revision.commitSha), archive };
	} catch {
		throw new DraftIntegrityError('Pinned draft repository failed Git verification');
	}
}

interface CanonicalDraftCommitInput {
	message: string;
	markdownEdits: readonly DraftEdit[];
	provenance: {
		automationRunId: string | null;
		externalId: string | null;
	};
	documentSet: DocumentSetMutation | null;
}

function canonicalizeCommitInput(input: CommitDraftInput): CanonicalDraftCommitInput {
	if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
		throw new Error('Draft commits require a valid idempotency key');
	}
	const message: string = input.message.trim();
	if (
		message.length === 0 ||
		message.length > MAX_COMMIT_MESSAGE_LENGTH ||
		hasControlCharacter(message)
	) {
		throw new Error('Draft commit message is invalid');
	}

	const provenance = {
		automationRunId: normalizeProvenanceValue(input.provenance?.automationRunId),
		externalId: normalizeProvenanceValue(input.provenance?.externalId)
	};

	if (input.documentSet !== undefined) {
		if (input.edits.length !== 0) {
			throw new Error('Document set mutations cannot include document edits');
		}
		if (input.documentSet.op === 'appendPdf') {
			const mutation: DocumentSetMutation = {
				op: 'appendPdf',
				title: input.documentSet.title,
				sha256: input.documentSet.sha256,
				byteSize: input.documentSet.byteSize,
				pageCount: input.documentSet.pageCount,
				pageWidth: input.documentSet.pageWidth,
				pageHeight: input.documentSet.pageHeight,
				position: input.documentSet.position
			};
			return { message, markdownEdits: [], provenance, documentSet: mutation };
		}
		if (input.documentSet.documentIds.length < 1 || input.documentSet.documentIds.length > 20) {
			throw new Error('Document order must list between 1 and 20 documents');
		}
		for (const id of input.documentSet.documentIds) {
			if (!isUuidV7(id)) throw new Error('Document order contains an invalid document id');
		}
		return {
			message,
			markdownEdits: [],
			provenance,
			documentSet: { op: 'reorder', documentIds: [...input.documentSet.documentIds] }
		};
	}

	if (input.edits.length < 1 || input.edits.length > MAX_DRAFT_EDITS) {
		throw new Error(`Draft commits require between 1 and ${MAX_DRAFT_EDITS} edits`);
	}

	let totalBytes: number = 0;
	const edits: DraftEdit[] = input.edits.map((edit: DraftEdit): DraftEdit => {
		assertDraftPath(edit.path);
		if (!isMarkdownPath(edit.path)) {
			throw new Error('Draft commits accept Markdown files under documents/ only');
		}
		if (new TextEncoder().encode(edit.path).byteLength > 240) {
			throw new Error('Draft document path is too long');
		}
		if (edit.content.includes(NUL_CHARACTER)) {
			throw new Error('Draft document contains a NUL byte');
		}
		const content: string = normalizeMarkdownContent(edit.content);
		const contentBytes: number = new TextEncoder().encode(content).byteLength;
		if (contentBytes > MAX_DRAFT_CONTENT_BYTES) {
			throw new Error('Draft document exceeds the per-file size limit');
		}
		totalBytes += contentBytes;
		if (totalBytes > MAX_DRAFT_TOTAL_CONTENT_BYTES) {
			throw new Error('Draft documents exceed the total size limit');
		}
		return { path: edit.path, content };
	});
	edits.sort((left: DraftEdit, right: DraftEdit): number =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0
	);
	for (let index: number = 1; index < edits.length; index += 1) {
		if (edits[index - 1].path === edits[index].path) {
			throw new Error('Draft commits cannot edit the same path more than once');
		}
	}

	return {
		message,
		markdownEdits: edits,
		provenance,
		documentSet: null
	};
}

function normalizeProvenanceValue(value: string | undefined): string | null {
	if (value === undefined) return null;
	const normalized: string = value.trim();
	if (
		normalized.length === 0 ||
		normalized.length > MAX_PROVENANCE_VALUE_LENGTH ||
		hasControlCharacter(normalized)
	) {
		throw new Error('Draft provenance value is invalid');
	}
	return normalized;
}

function throwForPreparationFailure(
	preparation: DraftRevisionPreparation,
	expectedGeneration: number
): void {
	switch (preparation.outcome) {
		case 'ready':
		case 'replayed':
			return;
		case 'idempotency_conflict':
			throw new DraftIdempotencyConflictError();
		case 'not_found':
			throw new DraftEnvelopeNotFoundError();
		case 'immutable':
			throw new DraftEnvelopeImmutableError();
		case 'generation_conflict':
			throw new DraftGenerationConflictError(expectedGeneration);
		case 'integrity_error':
			throw new DraftIntegrityError('Draft command state failed its integrity check');
	}
}

function throwForPublicationFailure(
	publication: PublishDraftRevisionResult,
	expectedGeneration: number
): void {
	switch (publication.outcome) {
		case 'published':
		case 'replayed':
			return;
		case 'idempotency_conflict':
			throw new DraftIdempotencyConflictError();
		case 'not_found':
			throw new DraftEnvelopeNotFoundError();
		case 'immutable':
			throw new DraftEnvelopeImmutableError();
		case 'generation_conflict':
		case 'audit_conflict':
			throw new DraftGenerationConflictError(expectedGeneration);
		case 'integrity_error':
			throw new DraftIntegrityError('Draft publication failed its integrity check');
	}
}

async function sha256Text(value: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(value));
}

function assertIsoTimestamp(value: string): void {
	const date: Date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
		throw new DraftIntegrityError('Draft revision timestamp is invalid');
	}
}

export function draftArchiveKey(envelopeId: string, archiveSha256: string): string {
	assertScopedIdentifier(envelopeId, 'envelope');
	assertSha256(archiveSha256);
	return `draft-repositories/v1/envelopes/${encodeScopeSegment(envelopeId)}/sha256/${archiveSha256}.git.gz`;
}

function sameDraftPointer(left: Envelope, right: Envelope): boolean {
	return (
		left.id === right.id &&
		left.repositoryGeneration === right.repositoryGeneration &&
		left.repositoryHead === right.repositoryHead &&
		left.repositoryArchiveKey === right.repositoryArchiveKey &&
		left.repositoryArchiveSha256 === right.repositoryArchiveSha256
	);
}

async function verifyRepositoryVersion(version: DraftVersion): Promise<string> {
	if (!GIT_SHA_PATTERN.test(version.commitSha)) {
		throw new DraftIntegrityError('Draft repository returned an invalid Git commit SHA');
	}
	if (version.archive.byteLength > MAX_ARCHIVE_BYTES) {
		throw new DraftIntegrityError('Draft repository archive exceeds the size limit');
	}
	assertSha256(version.archiveSha256);
	const externallyComputedSha256 = await sha256Hex(version.archive);
	if (externallyComputedSha256 !== version.archiveSha256) {
		throw new DraftIntegrityError('Draft repository returned an invalid archive SHA-256');
	}
	return externallyComputedSha256;
}

function assertStoredMetadata(
	metadata: ObjectMetadata,
	key: string,
	size: number,
	sha256: string
): void {
	if (metadata.key !== key || metadata.size !== size || metadata.sha256 !== sha256) {
		throw new DraftIntegrityError('Object store did not confirm the immutable draft archive');
	}
}

async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			const chunk = result.value;
			size += chunk.byteLength;
			if (size > maximumBytes) {
				await reader.cancel('Draft repository archive exceeds the size limit');
				throw new DraftIntegrityError('Draft repository archive exceeds the size limit');
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number) =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

function parseRevisionReference(
	input: string
): { kind: 'generation'; value: number } | { kind: 'commit'; value: string } {
	const value = input.trim().toLowerCase();
	// A 40-digit Git SHA is a commit, not a huge decimal generation.
	if (GIT_SHA_PATTERN.test(value)) return { kind: 'commit', value };
	if (/^\d{1,10}$/.test(value)) {
		const generation = Number(value);
		if (Number.isSafeInteger(generation) && generation <= MAX_DRAFT_GENERATION) {
			return { kind: 'generation', value: generation };
		}
	}
	throw new DraftRevisionNotFoundError('Invalid revision reference');
}

function assertGeneration(generation: number): void {
	if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_DRAFT_GENERATION) {
		throw new DraftIntegrityError('Draft repository generation is invalid');
	}
}

function assertSha256(value: string): void {
	if (!SHA256_PATTERN.test(value)) {
		throw new DraftIntegrityError('Draft archive SHA-256 is invalid');
	}
}

function assertScopedIdentifier(value: string, kind: 'envelope' | 'actor'): void {
	const byteLength = new TextEncoder().encode(value).byteLength;
	if (value.length === 0 || byteLength > 256 || hasControlCharacter(value)) {
		throw new Error(`Invalid ${kind} identifier`);
	}
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function encodeScopeSegment(value: string): string {
	// encodeURIComponent leaves dots unescaped; escaping them prevents any `..`
	// segment from reaching provider-specific key normalization.
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

function extractListedRevisionMetadata(
	locator: PersistedDraftRevisionLocator
): { message: string; provenance: DraftCommitProvenance | null } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(locator.auditPayloadJson) as unknown;
	} catch {
		throw new DraftIntegrityError('Stored draft revision audit payload is invalid');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new DraftIntegrityError('Stored draft revision audit payload is invalid');
	}
	const payload = parsed as Record<string, unknown>;
	if (
		payload.generation !== locator.generation ||
		payload.commitSha !== locator.commitSha ||
		payload.archiveSha256 !== locator.archiveSha256
	) {
		throw new DraftIntegrityError('Stored draft revision audit payload does not match its command');
	}
	if (payload.message === undefined) return null;
	if (
		typeof payload.message !== 'string' ||
		payload.message.length === 0 ||
		payload.message.length > MAX_COMMIT_MESSAGE_LENGTH ||
		hasControlCharacter(payload.message)
	) {
		throw new DraftIntegrityError('Stored draft revision message is invalid');
	}
	return {
		message: payload.message,
		provenance: extractAllowlistedProvenance(locator.auditPayloadJson)
	};
}

function extractAllowlistedProvenance(auditPayloadJson: string): DraftCommitProvenance | null {
	try {
		const payload = JSON.parse(auditPayloadJson) as Record<string, unknown>;
		if (
			payload &&
			typeof payload === 'object' &&
			payload.provenance &&
			typeof payload.provenance === 'object'
		) {
			const prov = payload.provenance as Record<string, unknown>;
			const result: DraftCommitProvenance = {};
			if (typeof prov.automationRunId === 'string' && prov.automationRunId.trim().length > 0) {
				result.automationRunId = prov.automationRunId.trim();
			}
			if (typeof prov.externalId === 'string' && prov.externalId.trim().length > 0) {
				result.externalId = prov.externalId.trim();
			}
			if (Object.keys(result).length > 0) {
				return result;
			}
		}
		return null;
	} catch {
		return null;
	}
}
