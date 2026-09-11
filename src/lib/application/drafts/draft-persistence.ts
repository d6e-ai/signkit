import { assertEnvelopeMutable, type Envelope } from '$lib/domain/envelope';
import type {
	DraftActor,
	DraftDocument,
	DraftEdit,
	DraftRepository,
	DraftVersion
} from '$lib/ports/draft-repository';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';

const ARCHIVE_CONTENT_TYPE = 'application/vnd.signkit.git-archive+gzip';
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_CURRENT_READ_ATTEMPTS = 3;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export interface ReadCurrentDraftInput {
	organizationId: string;
	envelopeId: string;
}

export interface CommitDraftInput extends ReadCurrentDraftInput {
	expectedGeneration: number;
	edits: readonly DraftEdit[];
	message: string;
	actor: DraftActor;
	updatedAt?: string;
}

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
 * envelope's compare-and-set pointer. Object writes happen before the pointer
 * update. A failed CAS therefore leaves an unreferenced, content-addressed
 * object; it must not be deleted on the request path because another writer
 * may have published the same object.
 */
export class DraftPersistenceService {
	constructor(
		private readonly envelopes: EnvelopeStore,
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

	async commit(input: CommitDraftInput): Promise<PersistedDraftSnapshot> {
		assertScopedIdentifier(input.organizationId, 'organization');
		assertScopedIdentifier(input.envelopeId, 'envelope');
		assertGeneration(input.expectedGeneration);
		if (input.message.trim().length === 0) throw new Error('Draft commit message is required');

		const envelope = await this.findEnvelope(input.organizationId, input.envelopeId);
		assertEnvelopeMutable(envelope.status);
		if (envelope.repositoryGeneration !== input.expectedGeneration) {
			throw new DraftGenerationConflictError(input.expectedGeneration);
		}

		const current = await this.loadSnapshot(envelope);
		const version = await this.repository.commit(
			current.archive,
			input.edits,
			input.message,
			input.actor
		);
		const archiveSha256 = await verifyRepositoryVersion(version);
		const archiveKey = draftArchiveKey(input.organizationId, input.envelopeId, archiveSha256);

		await this.persistImmutableArchive(archiveKey, version.archive, archiveSha256);

		const nextGeneration = input.expectedGeneration + 1;
		assertGeneration(nextGeneration);
		const updated = await this.envelopes.compareAndSetDraftPointer(
			input.organizationId,
			input.envelopeId,
			{
				expectedGeneration: input.expectedGeneration,
				nextGeneration,
				commitSha: version.commitSha,
				archiveKey,
				archiveSha256,
				updatedAt: input.updatedAt ?? new Date().toISOString()
			}
		);

		// Retrying against a newer archive could silently overwrite concurrent edits.
		// The immutable object remains safe and can be reclaimed by an offline GC.
		if (!updated) throw new DraftGenerationConflictError(input.expectedGeneration);

		return {
			generation: nextGeneration,
			commitSha: version.commitSha,
			archiveKey,
			archiveSha256,
			archive: version.archive
		};
	}

	private async findEnvelope(organizationId: string, envelopeId: string): Promise<Envelope> {
		const envelope = await this.envelopes.findForOrganization(organizationId, envelopeId);
		if (!envelope) throw new DraftEnvelopeNotFoundError();
		return envelope;
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
	if (!Number.isSafeInteger(generation) || generation < 0) {
		throw new DraftIntegrityError('Draft repository generation is invalid');
	}
}

function assertSha256(value: string): void {
	if (!SHA256_PATTERN.test(value)) {
		throw new DraftIntegrityError('Draft archive SHA-256 is invalid');
	}
}

function assertScopedIdentifier(value: string, kind: 'organization' | 'envelope'): void {
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
