import { MAX_DRAFT_GENERATION, normalizeMarkdownContent } from '$lib/domain/draft';
import { assertMarkdownPath, type Envelope } from '$lib/domain/envelope';
import type {
	DraftMutationStore,
	DraftRevisionKey,
	DraftRevisionPreparation,
	PublishedDraftRevision,
	PublishDraftRevisionResult
} from '$lib/ports/draft-mutation-store';
import type {
	DraftActor,
	DraftDocument,
	DraftEdit,
	DraftRepository,
	DraftVersion
} from '$lib/ports/draft-repository';
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

export interface ReadCurrentDraftInput {
	organizationId: string;
	envelopeId: string;
}

export interface CommitDraftInput extends ReadCurrentDraftInput {
	expectedGeneration: number;
	edits: readonly DraftEdit[];
	message: string;
	actor: DraftActor;
	idempotencyKey: string;
	provenance?: DraftCommitProvenance;
	updatedAt?: string;
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
}

export interface ImmutableDraftRevision {
	organizationId: string;
	envelopeId: string;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
}

export class DraftEnvelopeNotFoundError extends Error {
	readonly code = 'DRAFT_ENVELOPE_NOT_FOUND';

	constructor() {
		super('Draft envelope was not found in the organization');
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
		private readonly repository: DraftRepository
	) {}

	async readCurrent(input: ReadCurrentDraftInput): Promise<DraftSnapshot> {
		assertScopedIdentifier(input.organizationId, 'organization');
		assertScopedIdentifier(input.envelopeId, 'envelope');

		for (let attempt = 0; attempt < MAX_CURRENT_READ_ATTEMPTS; attempt += 1) {
			const before = await this.findEnvelope(input.organizationId, input.envelopeId);
			const snapshot = await this.loadSnapshot(before);
			const after = await this.findEnvelope(input.organizationId, input.envelopeId);

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
		return {
			generation: snapshot.generation,
			commitSha: snapshot.commitSha,
			archiveKey: snapshot.archiveKey,
			archiveSha256: snapshot.archiveSha256,
			documents
		};
	}

	async commit(input: CommitDraftInput): Promise<CommitDraftResult> {
		assertScopedIdentifier(input.organizationId, 'organization');
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
				edits: canonical.edits,
				provenance: canonical.provenance
			})
		);
		const key: DraftRevisionKey = {
			organizationId: input.organizationId,
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
		if (
			preparation.envelope.organizationId !== input.organizationId ||
			preparation.envelope.id !== input.envelopeId
		) {
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
		const version = await this.repository.commit(
			current.archive,
			canonical.edits,
			canonical.message,
			input.actor
		);
		const archiveSha256: string = await verifyRepositoryVersion(version);
		const archiveKey: string = draftArchiveKey(
			input.organizationId,
			input.envelopeId,
			archiveSha256
		);

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
			archiveSha256,
			changedPaths: canonical.edits.map((edit: DraftEdit): string => edit.path),
			provenance: canonical.provenance
		};
		const auditPayloadJson: string = JSON.stringify(auditPayload);
		const auditEventId: string = await deterministicUuid(
			[
				'signkit-draft-revision-v1',
				input.organizationId,
				input.actor.type,
				input.actor.id,
				input.idempotencyKey
			].join('\u0000')
		);
		const auditEventHash: string = await sha256Text(
			JSON.stringify({
				organizationId: input.organizationId,
				envelopeId: input.envelopeId,
				sequence: auditSequence,
				eventType: 'draft.revision_created',
				actorType: input.actor.type,
				actorId: input.actor.id,
				occurredAt: updatedAt,
				payload: auditPayload,
				previousHash: preparation.auditHead.eventHash
			})
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

	private async findEnvelope(organizationId: string, envelopeId: string): Promise<Envelope> {
		const envelope = await this.store.findForOrganization(organizationId, envelopeId);
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
		const expectedAuditEventId: string = await deterministicUuid(
			[
				'signkit-draft-revision-v1',
				input.organizationId,
				input.actor.type,
				input.actor.id,
				input.idempotencyKey
			].join('\u0000')
		);
		if (revision.auditEventId !== expectedAuditEventId) {
			throw new DraftIntegrityError('Stored draft command has an invalid audit event ID');
		}
		assertSha256(revision.archiveSha256);
		const expectedKey: string = draftArchiveKey(
			input.organizationId,
			input.envelopeId,
			revision.archiveSha256
		);
		if (revision.archiveKey !== expectedKey) {
			throw new DraftIntegrityError('Stored draft command has an invalid archive key');
		}
		await readImmutableDraftRevision(
			{
				organizationId: input.organizationId,
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

		const expectedKey = draftArchiveKey(envelope.organizationId, envelope.id, archiveSha256);
		if (archiveKey !== expectedKey) {
			throw new DraftIntegrityError('Draft archive key does not match its organization scope');
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
): Promise<readonly DraftDocument[]> {
	if (!GIT_SHA_PATTERN.test(revision.commitSha)) {
		throw new DraftIntegrityError('Pinned draft revision has an invalid Git commit SHA');
	}
	assertSha256(revision.archiveSha256);
	const expectedKey: string = draftArchiveKey(
		revision.organizationId,
		revision.envelopeId,
		revision.archiveSha256
	);
	if (revision.archiveKey !== expectedKey) {
		throw new DraftIntegrityError('Pinned draft archive key does not match its organization scope');
	}
	const stream: ReadableStream<Uint8Array> | null = await objects.get(revision.archiveKey);
	if (stream === null) throw new DraftIntegrityError('Pinned draft repository archive is missing');
	const archive: Uint8Array = await readStreamBounded(stream, MAX_ARCHIVE_BYTES);
	const actualSha256: string = await sha256Hex(archive);
	if (actualSha256 !== revision.archiveSha256) {
		throw new DraftIntegrityError('Pinned draft repository archive failed SHA-256 verification');
	}
	try {
		return await repository.read(archive, revision.commitSha);
	} catch {
		throw new DraftIntegrityError('Pinned draft repository failed Git verification');
	}
}

interface CanonicalDraftCommitInput {
	message: string;
	edits: readonly DraftEdit[];
	provenance: {
		automationRunId: string | null;
		externalId: string | null;
	};
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
	if (input.edits.length < 1 || input.edits.length > MAX_DRAFT_EDITS) {
		throw new Error(`Draft commits require between 1 and ${MAX_DRAFT_EDITS} edits`);
	}

	let totalBytes: number = 0;
	const edits: DraftEdit[] = input.edits.map((edit: DraftEdit): DraftEdit => {
		assertMarkdownPath(edit.path);
		if (new TextEncoder().encode(edit.path).byteLength > 240) {
			throw new Error('Draft document path is too long');
		}
		if (edit.content.includes('\u0000')) throw new Error('Draft document contains a NUL byte');
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
		edits,
		provenance: {
			automationRunId: normalizeProvenanceValue(input.provenance?.automationRunId),
			externalId: normalizeProvenanceValue(input.provenance?.externalId)
		}
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

async function deterministicUuid(value: string): Promise<string> {
	const digest: string = await sha256Text(value);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(
		17,
		20
	)}-${digest.slice(20, 32)}`;
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

export function draftArchiveKey(
	organizationId: string,
	envelopeId: string,
	archiveSha256: string
): string {
	assertScopedIdentifier(organizationId, 'organization');
	assertScopedIdentifier(envelopeId, 'envelope');
	assertSha256(archiveSha256);
	return `draft-repositories/v1/organizations/${encodeScopeSegment(organizationId)}/envelopes/${encodeScopeSegment(envelopeId)}/sha256/${archiveSha256}.git.gz`;
}

function sameDraftPointer(left: Envelope, right: Envelope): boolean {
	return (
		left.organizationId === right.organizationId &&
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

function assertScopedIdentifier(value: string, kind: 'organization' | 'envelope' | 'actor'): void {
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
