import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { draftArchiveKey } from '$lib/application/drafts/draft-persistence';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import type {
	ClaimCompletionArtifactsCommand,
	ClaimedCompletionArtifactJob,
	CompletionArtifactStatusRow,
	CompletionArtifactStore,
	CompletionEvidence,
	FailCompletionArtifactCommand,
	FailCompletionArtifactResult,
	PublishCompletionArtifactCommand,
	PublishCompletionArtifactResult,
	PublishedCompletionArtifact,
	ReadClaimedCompletionArtifactCommand
} from '$lib/ports/completion-artifact-store';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import { OPAQUE_TOKEN_PATTERN } from '$lib/security/opaque-token';
import { buildVerifiedAuditChain } from './audit-chain-test-support';
import {
	completionArtifactObjectKey,
	CompletionArtifactPublicationService,
	MAX_COMPLETION_ARTIFACT_ATTEMPTS,
	type CompletionArtifactBatchResult
} from './completion-artifact-service';

const NOW: Date = new Date('2026-09-12T00:00:00.000Z');
const SENT_COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = 'envelope-1';

interface StoredObject {
	body: Uint8Array;
	sha256: string;
}

class MemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, StoredObject>();
	putCallsByKey = new Map<string, number>();
	getCallsByKey = new Map<string, number>();

	seed(key: string, body: Uint8Array, sha256: string): void {
		this.objects.set(key, { body: Uint8Array.from(body), sha256 });
	}

	async head(): Promise<ObjectMetadata | null> {
		throw new Error('unused');
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		putCounts(this.getCallsByKey, key);
		const object = this.objects.get(key);
		if (!object) return null;
		const body = Uint8Array.from(object.body);
		return new ReadableStream<Uint8Array>({
			start(controller): void {
				controller.enqueue(body);
				controller.close();
			}
		});
	}

	async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
		putCounts(this.putCallsByKey, key);
		if (this.objects.has(key)) throw new Error('Object already exists');
		if (!(object.body instanceof Uint8Array)) throw new Error('Test store requires buffered input');
		const stored: StoredObject = { body: Uint8Array.from(object.body), sha256: object.sha256 };
		this.objects.set(key, stored);
		return {
			key,
			contentType: object.contentType,
			size: stored.body.byteLength,
			sha256: stored.sha256,
			version: null
		};
	}

	async delete(): Promise<void> {
		throw new Error('unused');
	}

	async list(): Promise<Awaited<ReturnType<ObjectStore['list']>>> {
		throw new Error('unused');
	}

	async deleteMany(): Promise<void> {
		throw new Error('unused');
	}
}

/** Simulates a transient object-store outage: every read fails with a plain Error, never DraftIntegrityError. */
class ThrowingObjectStore implements ObjectStore {
	async head(): Promise<ObjectMetadata | null> {
		throw new Error('object store unavailable');
	}

	async get(): Promise<ReadableStream<Uint8Array> | null> {
		throw new Error('object store unavailable');
	}

	async putImmutable(): Promise<ObjectMetadata> {
		throw new Error('object store unavailable');
	}

	async delete(): Promise<void> {
		throw new Error('object store unavailable');
	}

	async list(): Promise<Awaited<ReturnType<ObjectStore['list']>>> {
		throw new Error('object store unavailable');
	}

	async deleteMany(): Promise<void> {
		throw new Error('object store unavailable');
	}
}

/**
 * Serves only the seeded draft archive; every other key (the completion
 * artifact's own content-addressed objects) reads as missing, and every put
 * fails as if the write never landed. Used to prove a failed put is retried
 * rather than treated as an integrity conflict when the object is genuinely
 * absent.
 */
class ArchiveOnlyObjectStore implements ObjectStore {
	constructor(
		private readonly archiveKey: string,
		private readonly archiveBytes: Uint8Array
	) {}

	async head(): Promise<ObjectMetadata | null> {
		throw new Error('unused');
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		if (key !== this.archiveKey) return null;
		const body = Uint8Array.from(this.archiveBytes);
		return new ReadableStream<Uint8Array>({
			start(controller): void {
				controller.enqueue(body);
				controller.close();
			}
		});
	}

	async putImmutable(): Promise<ObjectMetadata> {
		throw new Error('simulated transient write failure');
	}

	async delete(): Promise<void> {
		throw new Error('unused');
	}

	async list(): Promise<Awaited<ReturnType<ObjectStore['list']>>> {
		throw new Error('unused');
	}

	async deleteMany(): Promise<void> {
		throw new Error('unused');
	}
}

function putCounts(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

class FixedDraftRepository implements DraftRepository {
	constructor(
		private readonly expectedCommitSha: string,
		private readonly documents: readonly DraftDocument[]
	) {}

	async read(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<readonly DraftDocument[]> {
		if (expectedCommitSha !== this.expectedCommitSha) throw new Error('Unexpected commit SHA');
		return this.documents;
	}

	async commit(): Promise<DraftVersion> {
		throw new Error('Unexpected repository commit');
	}
}

class FakeCompletionArtifactStore implements CompletionArtifactStore {
	claims: ClaimedCompletionArtifactJob[] = [];
	claimCommands: ClaimCompletionArtifactsCommand[] = [];
	staleEnvelopeIds = new Set<string>();
	evidenceByEnvelope = new Map<string, CompletionEvidence>();
	publishResult: PublishCompletionArtifactResult = {
		outcome: 'published',
		result: publishedFrom(undefined)
	};
	publishCalls: PublishCompletionArtifactCommand[] = [];
	failCalls: FailCompletionArtifactCommand[] = [];
	failResult: FailCompletionArtifactResult = { outcome: 'failed' };

	async claimPendingCompletionArtifacts(
		command: ClaimCompletionArtifactsCommand
	): Promise<readonly ClaimedCompletionArtifactJob[]> {
		this.claimCommands.push(command);
		return this.claims;
	}

	async readClaimedCompletionArtifact(
		command: ReadClaimedCompletionArtifactCommand
	): Promise<ClaimedCompletionArtifactJob | null> {
		if (this.staleEnvelopeIds.has(command.envelopeId)) return null;
		return this.claims.find((claim) => claim.envelopeId === command.envelopeId) ?? null;
	}

	async readCompletionEvidence(
		_organizationId: string,
		envelopeId: string
	): Promise<CompletionEvidence> {
		const evidence = this.evidenceByEnvelope.get(envelopeId);
		if (evidence === undefined) throw new Error('Missing evidence fixture');
		return evidence;
	}

	async publishCompletionArtifact(
		command: PublishCompletionArtifactCommand
	): Promise<PublishCompletionArtifactResult> {
		this.publishCalls.push(command);
		return this.publishResult;
	}

	async failCompletionArtifact(
		command: FailCompletionArtifactCommand
	): Promise<FailCompletionArtifactResult> {
		this.failCalls.push(command);
		return this.failResult;
	}

	async findCompletionArtifactStatus(): Promise<CompletionArtifactStatusRow | null> {
		return null;
	}
}

function publishedFrom(
	overrides: Partial<PublishedCompletionArtifact> | undefined
): PublishedCompletionArtifact {
	return {
		envelopeId: ENVELOPE_ID,
		manifestSha256: 'manifest-sha',
		jsonSha256: 'json-sha',
		markdownSha256: 'markdown-sha',
		publishedAt: NOW.toISOString(),
		auditEventId: 'audit-event',
		...overrides
	};
}

const DEFAULT_ARCHIVE_SHA256: string = 'a'.repeat(64);
const FIELD_VALUE_JSON: string = '"Signed"';
const FIELD_VALUE_SHA256: string = sha256Hex(new TextEncoder().encode(FIELD_VALUE_JSON));

/** Narrows a nullable claim field for test helpers that construct only complete (non-corrupt) claims. */
function requireString(value: string | null): string {
	if (value === null) throw new Error('Expected a non-null claim field in this test fixture');
	return value;
}

function claim(
	overrides: Partial<ClaimedCompletionArtifactJob> = {}
): ClaimedCompletionArtifactJob {
	const archiveSha256: string = overrides.repositoryArchiveSha256 ?? DEFAULT_ARCHIVE_SHA256;
	return {
		organizationId: ORGANIZATION_ID,
		envelopeId: ENVELOPE_ID,
		attempts: 1,
		lockedAt: NOW.toISOString(),
		envelopeTitle: 'Agreement',
		sentCommitSha: SENT_COMMIT_SHA,
		repositoryArchiveKey: draftArchiveKey(ORGANIZATION_ID, ENVELOPE_ID, archiveSha256),
		repositoryArchiveSha256: archiveSha256,
		fieldGeneration: 1,
		...overrides
	};
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

const SIGNED_AT: string = '2026-09-11T00:00:00.000Z';
const COMPLETED_AT: string = '2026-09-11T00:01:00.000Z';

async function baseEvidence(): Promise<CompletionEvidence> {
	const auditEvents = await buildVerifiedAuditChain(
		{ organizationId: ORGANIZATION_ID, envelopeId: ENVELOPE_ID },
		[
			{
				id: 'event-1',
				eventType: 'envelope.created',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: '2026-09-10T00:00:00.000Z',
				payload: { title: 'Agreement' }
			},
			{
				id: 'event-ready',
				eventType: 'envelope.ready',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: '2026-09-10T00:00:30.000Z',
				payload: {
					commitSha: SENT_COMMIT_SHA,
					generation: 1,
					recipients: [{ id: 'recipient-1', role: 'signer', routingOrder: 1 }]
				}
			},
			{
				id: 'event-2',
				eventType: 'recipient.signed',
				actorType: 'recipient',
				actorId: 'recipient-1',
				occurredAt: SIGNED_AT,
				payload: {
					recipientId: 'recipient-1',
					role: 'signer',
					routingOrder: 1,
					sentCommitSha: SENT_COMMIT_SHA,
					fields: [{ id: 'field-1', fieldType: 'signature', valueSha256: FIELD_VALUE_SHA256 }],
					signedAt: SIGNED_AT
				}
			},
			{
				id: 'event-3',
				eventType: 'envelope.completed',
				actorType: 'recipient',
				actorId: 'recipient-1',
				occurredAt: COMPLETED_AT,
				payload: { sentCommitSha: SENT_COMMIT_SHA, completedAt: COMPLETED_AT }
			}
		]
	);
	return {
		recipients: [
			{
				id: 'recipient-1',
				role: 'signer',
				routingOrder: 1,
				status: 'completed',
				decisionEventId: 'event-2',
				decisionOccurredAt: SIGNED_AT
			}
		],
		fields: [
			{
				id: 'field-1',
				fieldType: 'signature',
				valueJson: FIELD_VALUE_JSON,
				valueSha256: FIELD_VALUE_SHA256
			}
		],
		auditEvents
	};
}

function claimWithSeededArchive(
	objects: MemoryObjectStore,
	overrides: Partial<ClaimedCompletionArtifactJob> = {}
): ClaimedCompletionArtifactJob {
	const archiveBytes: Uint8Array = new TextEncoder().encode('fake-git-archive');
	const archiveSha256: string = sha256Hex(archiveBytes);
	const claimed: ClaimedCompletionArtifactJob = claim({
		repositoryArchiveSha256: archiveSha256,
		...overrides
	});
	objects.seed(requireString(claimed.repositoryArchiveKey), archiveBytes, archiveSha256);
	return claimed;
}

function documents(): readonly DraftDocument[] {
	return [{ path: 'documents/agreement.md', content: 'Agreement body' }];
}

describe('CompletionArtifactPublicationService.publishPendingCompletionArtifacts', () => {
	it('mints an opaque lease claim token by default, not a UUIDv7', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());

		await new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW
		).publishPendingCompletionArtifacts();

		expect(store.claimCommands).toHaveLength(1);
		expect(store.claimCommands[0].claimToken).toMatch(OPAQUE_TOKEN_PATTERN);
		expect(store.claimCommands[0].claimToken).not.toMatch(UUID_V7_PATTERN);
	});

	it('builds, persists, and publishes a completion artifact for a claimed envelope', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW,
			() => 'claim-token-0001'
		);

		const result: CompletionArtifactBatchResult = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ claimed: 1, published: 1, stale: 0, retryableFailed: 0 });
		expect(store.publishCalls).toHaveLength(1);
		const published = store.publishCalls[0];
		expect(published.sentCommitSha).toBe(SENT_COMMIT_SHA);
		expect(published.anchorAuditEventId).toBe('event-3');
		expect(published.expectedAuditSequence).toBe(4);
		expect(published.jsonObjectKey).toBe(
			completionArtifactObjectKey(ORGANIZATION_ID, ENVELOPE_ID, 'json', published.jsonSha256)
		);
		expect(published.markdownObjectKey).toBe(
			completionArtifactObjectKey(
				ORGANIZATION_ID,
				ENVELOPE_ID,
				'markdown',
				published.markdownSha256
			)
		);
	});

	it('reuses identical content-addressed bytes when the object already exists', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const first = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW,
			() => 'claim-token-0001'
		);
		await first.publishPendingCompletionArtifacts();
		const firstJsonKey: string = store.publishCalls[0].jsonObjectKey;

		// Simulate the SQL publish failing after the object write already succeeded:
		// a second attempt recomputes identical bytes and must safely reuse the key.
		store.publishCalls = [];
		const second = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW,
			() => 'claim-token-0002'
		);
		const result = await second.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ published: 1 });
		expect(store.publishCalls[0].jsonObjectKey).toBe(firstJsonKey);
	});

	it('fails closed immediately when an existing object holds different bytes at the same key', async () => {
		// First learn the content-addressed key this fixed evidence hashes to.
		const probeStore = new FakeCompletionArtifactStore();
		const probeObjects = new MemoryObjectStore();
		probeStore.claims = [claimWithSeededArchive(probeObjects)];
		probeStore.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		await new CompletionArtifactPublicationService(
			probeStore,
			probeObjects,
			new FixedDraftRepository(SENT_COMMIT_SHA, documents()),
			() => NOW
		).publishPendingCompletionArtifacts();
		const { jsonObjectKey } = probeStore.publishCalls[0];

		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		// A should-be-impossible content-addressed collision: different bytes
		// already occupy the exact key our real manifest will hash to.
		objects.seed(jsonObjectKey, new TextEncoder().encode('not-the-real-manifest'), 'b'.repeat(64));
		store.claims = [claimWithSeededArchive(objects)];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});
	});

	it('remains retryable when a put fails and the object is genuinely missing', async () => {
		const store = new FakeCompletionArtifactStore();
		const archiveBytes: Uint8Array = new TextEncoder().encode('fake-git-archive');
		const archiveSha256: string = sha256Hex(archiveBytes);
		const claimed: ClaimedCompletionArtifactJob = claim({ repositoryArchiveSha256: archiveSha256 });
		const objects = new ArchiveOnlyObjectStore(
			requireString(claimed.repositoryArchiveKey),
			archiveBytes
		);
		store.claims = [claimed];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ retryableFailed: 1, integrityFailed: 0, published: 0 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_build_failed',
			retryable: true
		});
	});

	it('returns stale without failing when the lease is lost before evidence is read', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claim()];
		store.staleEnvelopeIds.add(ENVELOPE_ID);
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ claimed: 1, stale: 1, published: 0 });
		expect(store.failCalls).toHaveLength(0);
	});

	it('reports stale without a retry when publication observes a lost lease', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		store.publishResult = { outcome: 'stale' };
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ stale: 1, published: 0 });
		expect(store.failCalls).toHaveLength(0);
	});

	it('marks an integrity conflict from publication as a non-retryable integrity failure', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		store.publishResult = { outcome: 'integrity_error' };
		store.failResult = { outcome: 'failed' };
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ integrityFailed: 1 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_integrity_conflict',
			retryable: false
		});
	});

	it('classifies a manifest-building integrity failure as non-retryable', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		// An empty audit chain fails manifest construction closed.
		store.evidenceByEnvelope.set(ENVELOPE_ID, { ...(await baseEvidence()), auditEvents: [] });
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});
	});

	it('publishes the operator-safe too-large error code for a resource bound, not evidence-invalid', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		const evidence = await baseEvidence();
		const extraValueJson: string = '"x"';
		const extraValueSha256: string = sha256Hex(new TextEncoder().encode(extraValueJson));
		const oversizedFields = Array.from({ length: 51 }, (_, index) => ({
			id: `field-extra-${index}`,
			fieldType: 'text' as const,
			valueJson: extraValueJson,
			valueSha256: extraValueSha256
		}));
		store.evidenceByEnvelope.set(ENVELOPE_ID, { ...evidence, fields: oversizedFields });
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_too_large',
			retryable: false
		});
	});

	it('fails closed and publishes nothing when a field value_json no longer matches its value_sha256', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		// Tampering: value_json changed but value_sha256 left untouched.
		store.evidenceByEnvelope.set(ENVELOPE_ID, {
			...(await baseEvidence()),
			fields: [
				{
					id: 'field-1',
					fieldType: 'signature',
					valueJson: '"Tampered"',
					valueSha256: FIELD_VALUE_SHA256
				}
			]
		});
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});
		expect(store.publishCalls).toHaveLength(0);
		expect(objects.putCallsByKey.size).toBe(0);
	});

	it('classifies a missing draft archive as a non-retryable integrity failure', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		store.claims = [claim()];
		// No archive seeded: readImmutableDraftRevision throws DraftIntegrityError.
		// R2/S3 are strongly consistent for these immutable pointers, so a missing
		// object is real evidence corruption, not a transient condition.
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});
	});

	it('isolates a corrupt claim missing its repository pointer from a healthy sibling in the same batch', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new MemoryObjectStore();
		const healthyClaim = claimWithSeededArchive(objects);
		const corruptClaim = claim({
			envelopeId: 'envelope-corrupt',
			sentCommitSha: null,
			repositoryArchiveKey: null,
			repositoryArchiveSha256: null
		});
		store.claims = [corruptClaim, healthyClaim];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		// Deliberately no evidence fixture for 'envelope-corrupt': if the
		// pointer guard did not fire before readCompletionEvidence, this would
		// throw a plain Error (retryable), not an integrity error, so the
		// assertion below also proves no further work happened for this row.
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({
			claimed: 2,
			published: 1,
			integrityFailed: 1,
			retryableFailed: 0,
			stale: 0
		});

		const corruptFailure = store.failCalls.find((call) => call.envelopeId === 'envelope-corrupt');
		expect(corruptFailure).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});

		const healthyPublish = store.publishCalls.find((call) => call.envelopeId === ENVELOPE_ID);
		expect(healthyPublish).toBeDefined();
		expect(store.failCalls.some((call) => call.envelopeId === ENVELOPE_ID)).toBe(false);

		// No object access at all for the corrupt row: only the healthy
		// envelope's archive read and json+markdown writes ever happened.
		expect(objects.putCallsByKey.size).toBe(2);
		for (const key of objects.putCallsByKey.keys()) {
			expect(key).toContain(`/envelopes/${ENVELOPE_ID}/`);
			expect(key).not.toContain('envelope-corrupt');
		}
		expect(objects.getCallsByKey.size).toBe(1);
		for (const key of objects.getCallsByKey.keys()) {
			expect(key).not.toContain('envelope-corrupt');
		}
	});

	it('retries a transient object-store failure and eventually exhausts attempts', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new ThrowingObjectStore();
		store.claims = [claim({ attempts: MAX_COMPLETION_ARTIFACT_ATTEMPTS })];
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ permanentlyFailed: 1 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_attempts_exhausted',
			retryable: false
		});
	});
});
