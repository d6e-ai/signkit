import { createHash } from 'node:crypto';
import { gunzipSync } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { drawnSignaturePng } from '$lib/adapters/pdf/png-image-test-support';
import { signatureAssetKey } from '$lib/application/documents/signature-asset';
import { renderRevisionPdf, sentPdfObjectKey } from '$lib/application/documents/sent-document-pdf';
import { draftArchiveKey } from '$lib/application/drafts/draft-persistence';
import type { FieldGeometry } from '$lib/domain/envelope';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import {
	documentSetHash,
	serializeDocumentSet,
	upsertMarkdownDocument
} from '$lib/domain/document-set';
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
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore,
	PublishCompletionArtifactPdfCommand,
	PublishCompletionArtifactPdfResult
} from '$lib/ports/completion-artifact-pdf-store';
import type {
	CompletionPdfEvidenceStore,
	CompletionPdfFieldGeometry
} from '$lib/ports/completion-pdf-evidence-store';
import type {
	EnvelopeSentDocumentStore,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import { OPAQUE_TOKEN_PATTERN } from '$lib/security/opaque-token';
import { buildVerifiedAuditChain } from './audit-chain-test-support';
import {
	completionArtifactObjectKey,
	CompletionArtifactPublicationService,
	MAX_COMPLETION_ARTIFACT_ATTEMPTS,
	type CompletionArtifactBatchResult
} from './completion-artifact-service';
import { COMPLETION_PDF_MANIFEST_SCHEMA, type CompletionPdfManifestV2 } from './completion-pdf';

const NOW: Date = new Date('2026-09-12T00:00:00.000Z');
const SENT_COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const ENVELOPE_ID: string = 'envelope-1';

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

class FixedDraftRepository implements DraftRepository {
	constructor(
		private readonly expectedCommitSha: string,
		private readonly documents: readonly DraftDocument[],
		private readonly manifestJson: string | null = null
	) {}

	async read(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<readonly DraftDocument[]> {
		if (expectedCommitSha !== this.expectedCommitSha) throw new Error('Unexpected commit SHA');
		return this.documents;
	}

	async readManifest(): Promise<string | null> {
		return this.manifestJson;
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

	async readCompletionEvidence(envelopeId: string): Promise<CompletionEvidence> {
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

class FakeCompletionArtifactPdfStore implements CompletionArtifactPdfStore {
	calls: PublishCompletionArtifactPdfCommand[] = [];

	async publishCompletionArtifactPdf(
		command: PublishCompletionArtifactPdfCommand
	): Promise<PublishCompletionArtifactPdfResult> {
		this.calls.push(command);
		return { outcome: 'published' };
	}

	async readCompletionArtifactPdf(): Promise<CompletionArtifactPdfRecord | null> {
		return null;
	}
}

class FakeCompletionPdfEvidenceStore implements CompletionPdfEvidenceStore {
	constructor(private readonly geometry: readonly CompletionPdfFieldGeometry[] = []) {}

	async readFieldGeometry(): Promise<readonly CompletionPdfFieldGeometry[]> {
		return this.geometry;
	}
}

class FakeEnvelopeSentDocumentStore implements EnvelopeSentDocumentStore {
	constructor(readonly set: SentDocumentSetPointer | null) {}

	async findSet(): Promise<SentDocumentSetPointer | null> {
		return this.set;
	}

	async findDocument(): Promise<null> {
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
		envelopeId: ENVELOPE_ID,
		attempts: 1,
		lockedAt: NOW.toISOString(),
		envelopeTitle: 'Agreement',
		sentCommitSha: SENT_COMMIT_SHA,
		repositoryArchiveKey: draftArchiveKey(ENVELOPE_ID, archiveSha256),
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

async function baseEvidence(valueJson: string = FIELD_VALUE_JSON): Promise<CompletionEvidence> {
	const valueSha256: string = sha256Hex(new TextEncoder().encode(valueJson));
	const auditEvents = await buildVerifiedAuditChain({ envelopeId: ENVELOPE_ID }, [
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
				fields: [{ id: 'field-1', fieldType: 'signature', valueSha256: valueSha256 }],
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
	]);
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
		fields: [{ id: 'field-1', fieldType: 'signature', valueJson, valueSha256 }],
		auditEvents
	};
}

async function evidenceWithSent(
	sentPayload: Record<string, unknown>,
	valueJson: string = FIELD_VALUE_JSON,
	fieldPlacementPayload?: Record<string, unknown>
): Promise<CompletionEvidence> {
	const evidence = await baseEvidence(valueJson);
	const valueSha256: string = sha256Hex(new TextEncoder().encode(valueJson));
	const auditEvents = await buildVerifiedAuditChain({ envelopeId: ENVELOPE_ID }, [
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
		...(fieldPlacementPayload === undefined
			? []
			: [
					{
						id: 'event-fields',
						eventType: 'envelope.fields_placed',
						actorType: 'user',
						actorId: 'user-1',
						occurredAt: '2026-09-10T00:00:35.000Z',
						payload: fieldPlacementPayload
					}
				]),
		{
			id: 'event-sent',
			eventType: 'envelope.sent',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:40.000Z',
			payload: sentPayload
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
				fields: [{ id: 'field-1', fieldType: 'signature', valueSha256 }],
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
	]);
	return { ...evidence, auditEvents };
}

async function agentAuthoredEvidence(): Promise<CompletionEvidence> {
	const evidence = await baseEvidence();
	const auditEvents = await buildVerifiedAuditChain({ envelopeId: ENVELOPE_ID }, [
		{
			id: 'event-1',
			eventType: 'envelope.created',
			actorType: 'agent',
			actorId: 'api-key-1',
			occurredAt: '2026-09-10T00:00:00.000Z',
			payload: { title: 'Agreement' }
		},
		{
			id: 'event-commit',
			eventType: 'draft.revision_created',
			actorType: 'agent',
			actorId: 'api-key-1',
			occurredAt: '2026-09-10T00:00:10.000Z',
			payload: { generation: 1, commitSha: SENT_COMMIT_SHA }
		},
		{
			id: 'event-ready',
			eventType: 'envelope.ready',
			actorType: 'agent',
			actorId: 'api-key-1',
			occurredAt: '2026-09-10T00:00:30.000Z',
			payload: {
				commitSha: SENT_COMMIT_SHA,
				generation: 1,
				recipients: [{ id: 'recipient-1', role: 'signer', routingOrder: 1 }]
			}
		},
		{
			id: 'event-fields',
			eventType: 'envelope.fields_placed',
			actorType: 'agent',
			actorId: 'api-key-1',
			occurredAt: '2026-09-10T00:00:40.000Z',
			payload: { fieldGeneration: 1, fieldCount: 1 }
		},
		{
			id: 'event-sent',
			eventType: 'envelope.sent',
			actorType: 'agent',
			actorId: 'api-key-1',
			occurredAt: '2026-09-10T00:00:50.000Z',
			payload: { commitSha: SENT_COMMIT_SHA, generation: 1 }
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
	]);
	return { ...evidence, auditEvents };
}

function claimWithSeededArchive(
	objects: InMemoryObjectStore,
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

const MARKDOWN_DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000021';
const FIELD_GEOMETRY: FieldGeometry = { page: 1, x: 0.1, y: 0.6, width: 0.35, height: 0.08 };

interface ExecutedScenarioOptions {
	/** Defaults to a typed signature; pass a `sig:sha256:` reference for a drawn one. */
	valueJson?: string;
	geometry?: FieldGeometry | null;
	seedSignature?: Uint8Array;
	/** Seeds `seedSignature` under a different asset's digest, simulating tampering. */
	seedSignatureUnderDigestOf?: Uint8Array;
	/** Simulates a historical sent rendering that differs from today's renderer output. */
	sentMarkdownContent?: string;
}

interface ExecutedScenario {
	service: CompletionArtifactPublicationService;
	store: FakeCompletionArtifactStore;
	objects: InMemoryObjectStore;
	pdfStore: FakeCompletionArtifactPdfStore;
}

/**
 * A completed, document-set-era envelope: one Markdown document in the pinned
 * revision, one signed field with frozen geometry, and a PDF store wired up.
 */
async function executedScenario(options: ExecutedScenarioOptions = {}): Promise<ExecutedScenario> {
	const store = new FakeCompletionArtifactStore();
	const objects = new InMemoryObjectStore();
	store.claims = [claimWithSeededArchive(objects)];

	const valueJson: string = options.valueJson ?? JSON.stringify('Alex Signer');
	const manifest = upsertMarkdownDocument(
		null,
		'documents/agreement.md',
		sha256Hex(new TextEncoder().encode('Agreement body')),
		() => MARKDOWN_DOCUMENT_ID
	);
	const renderedSentPdf = renderRevisionPdf([
		{
			path: 'documents/agreement.md',
			content: options.sentMarkdownContent ?? 'Agreement body'
		}
	]);
	const sentPdfSha256: string = sha256Hex(renderedSentPdf.bytes);
	const sentPdfKey: string = sentPdfObjectKey(ENVELOPE_ID, sentPdfSha256);
	objects.seed(sentPdfKey, renderedSentPdf.bytes, sentPdfSha256);
	const leaf = manifest.documents[0];
	const sentDocumentSet: SentDocumentSetPointer = {
		envelopeId: ENVELOPE_ID,
		commitSha: SENT_COMMIT_SHA,
		documentSetHash: await documentSetHash(manifest),
		documentCount: 1,
		documents: [
			{
				envelopeId: ENVELOPE_ID,
				commitSha: SENT_COMMIT_SHA,
				documentId: leaf.id,
				position: leaf.position,
				kind: leaf.kind,
				title: leaf.title,
				objectKey: sentPdfKey,
				sha256: sentPdfSha256,
				byteSize: renderedSentPdf.bytes.byteLength,
				pageCount: renderedSentPdf.pageCount,
				pageWidth: renderedSentPdf.pageWidth,
				pageHeight: renderedSentPdf.pageHeight,
				createdAt: '2026-09-10T00:00:40.000Z'
			}
		],
		createdAt: '2026-09-10T00:00:40.000Z'
	};
	store.evidenceByEnvelope.set(
		ENVELOPE_ID,
		await evidenceWithSent(
			{
				commitSha: SENT_COMMIT_SHA,
				documentSetHash: sentDocumentSet.documentSetHash,
				documentCount: 1,
				documents: [
					{
						id: leaf.id,
						sha256: sentPdfSha256,
						byteSize: renderedSentPdf.bytes.byteLength,
						pageCount: renderedSentPdf.pageCount
					}
				]
			},
			valueJson,
			{
				commitSha: SENT_COMMIT_SHA,
				generation: 1,
				fieldGeneration: 1,
				fields: [
					{
						id: 'field-1',
						recipientId: 'recipient-1',
						documentId: MARKDOWN_DOCUMENT_ID,
						documentPath: null,
						fieldType: 'signature',
						required: true,
						position: 0,
						geometry: FIELD_GEOMETRY
					}
				]
			}
		)
	);
	const repository = new FixedDraftRepository(
		SENT_COMMIT_SHA,
		documents(),
		serializeDocumentSet(manifest)
	);

	const seeded: Uint8Array | undefined = options.seedSignature;
	if (seeded !== undefined) {
		const digestSource: Uint8Array = options.seedSignatureUnderDigestOf ?? seeded;
		const key: string = signatureAssetKey(ENVELOPE_ID, 'recipient-1', sha256Hex(digestSource));
		objects.seed(key, seeded, sha256Hex(seeded));
	}

	const pdfStore = new FakeCompletionArtifactPdfStore();
	const pdfEvidenceStore = new FakeCompletionPdfEvidenceStore([
		{
			id: 'field-1',
			documentId: MARKDOWN_DOCUMENT_ID,
			documentPath: null,
			position: 0,
			recipientId: 'recipient-1',
			fieldType: 'signature',
			required: true,
			geometry: options.geometry === undefined ? FIELD_GEOMETRY : options.geometry
		}
	]);

	return {
		store,
		objects,
		pdfStore,
		service: new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW,
			() => 'claim-token-executed',
			undefined,
			pdfStore,
			pdfEvidenceStore,
			new FakeEnvelopeSentDocumentStore(sentDocumentSet)
		)
	};
}

async function readObject(objects: InMemoryObjectStore, key: string): Promise<Uint8Array> {
	const stream = await objects.get(key);
	if (stream === null) throw new Error(`Expected a published object at ${key}`);
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
	}
	const total: number = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const bytes: Uint8Array = new Uint8Array(total);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function publishedPdfManifest(
	objects: InMemoryObjectStore,
	pdfStore: FakeCompletionArtifactPdfStore
): Promise<CompletionPdfManifestV2> {
	const gzip: Uint8Array = await readObject(objects, pdfStore.calls[0].pdfManifestObjectKey);
	return JSON.parse(new TextDecoder().decode(gunzipSync(gzip))) as CompletionPdfManifestV2;
}

async function pageTextOf(bytes: Uint8Array, pageNumber: number): Promise<string> {
	const task = getDocument({ data: Uint8Array.from(bytes) });
	const document = await task.promise;
	try {
		const content = await (await document.getPage(pageNumber)).getTextContent();
		return content.items
			.map((item: unknown): string =>
				typeof item === 'object' && item !== null && 'str' in item ? String(item.str) : ''
			)
			.join('');
	} finally {
		await task.destroy();
	}
}

describe('CompletionArtifactPublicationService.publishPendingCompletionArtifacts', () => {
	it('mints an opaque lease claim token by default, not a UUIDv7', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		expect(objects.getCallsByKey.get(requireString(store.claims[0].repositoryArchiveKey))).toBe(1);
		expect(published.jsonObjectKey).toBe(
			completionArtifactObjectKey(ENVELOPE_ID, 'json', published.jsonSha256)
		);
		expect(published.markdownObjectKey).toBe(
			completionArtifactObjectKey(ENVELOPE_ID, 'markdown', published.markdownSha256)
		);
	});

	it('publishes an envelope whose create/commit/ready/fields/sent events were authored by an API-key agent under audit hash v3', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new InMemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await agentAuthoredEvidence());
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const service = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW,
			() => 'claim-token-agent-1'
		);

		const result: CompletionArtifactBatchResult = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({
			claimed: 1,
			published: 1,
			integrityFailed: 0,
			retryableFailed: 0
		});
		expect(store.publishCalls).toHaveLength(1);
		expect(store.failCalls).toHaveLength(0);
		expect(store.publishCalls[0].expectedAuditSequence).toBe(7);
		expect(
			store.evidenceByEnvelope.get(ENVELOPE_ID)?.auditEvents.map((event) => event.actorType)
		).toEqual(['agent', 'agent', 'agent', 'agent', 'agent', 'recipient', 'recipient']);
		expect(
			store.evidenceByEnvelope
				.get(ENVELOPE_ID)
				?.auditEvents.every((event) => event.hashVersion === 3)
		).toBe(true);
	});

	it('reuses identical content-addressed bytes when the object already exists', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new InMemoryObjectStore();
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
		const probeObjects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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

	it('fails closed when the pinned documentSetHash does not match the verified envelope.sent payload', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new InMemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		const contentSha256: string = sha256Hex(new TextEncoder().encode('Agreement body'));
		const manifest = upsertMarkdownDocument(
			null,
			'documents/agreement.md',
			contentSha256,
			() => '01900000-0000-7000-8000-000000000021'
		);
		store.evidenceByEnvelope.set(
			ENVELOPE_ID,
			await evidenceWithSent({ documentSetHash: 'f'.repeat(64) })
		);
		const repository = new FixedDraftRepository(
			SENT_COMMIT_SHA,
			documents(),
			serializeDocumentSet(manifest)
		);
		const service = new CompletionArtifactPublicationService(store, objects, repository, () => NOW);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});
		expect(store.publishCalls).toHaveLength(0);
	});

	it('publishes when the pinned documentSetHash matches the verified envelope.sent payload', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new InMemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		const contentSha256: string = sha256Hex(new TextEncoder().encode('Agreement body'));
		const manifest = upsertMarkdownDocument(
			null,
			'documents/agreement.md',
			contentSha256,
			() => '01900000-0000-7000-8000-000000000021'
		);
		const pinnedHash: string = await documentSetHash(manifest);
		store.evidenceByEnvelope.set(
			ENVELOPE_ID,
			await evidenceWithSent({ documentSetHash: pinnedHash })
		);
		const repository = new FixedDraftRepository(
			SENT_COMMIT_SHA,
			documents(),
			serializeDocumentSet(manifest)
		);
		const service = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW,
			() => 'claim-token-document-set'
		);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ claimed: 1, published: 1, integrityFailed: 0 });
		expect(store.publishCalls).toHaveLength(1);
	});

	it('publishes the evidence summary as the PDF artifact for a legacy path-scoped envelope', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new InMemoryObjectStore();
		store.claims = [claimWithSeededArchive(objects)];
		store.evidenceByEnvelope.set(ENVELOPE_ID, await baseEvidence());
		const repository = new FixedDraftRepository(SENT_COMMIT_SHA, documents());
		const pdfStore = new FakeCompletionArtifactPdfStore();
		const pdfEvidenceStore = new FakeCompletionPdfEvidenceStore([
			{
				id: 'field-1',
				documentId: null,
				documentPath: 'documents/agreement.md',
				position: 0,
				recipientId: 'recipient-1',
				fieldType: 'signature',
				required: true,
				geometry: null
			}
		]);
		const service = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			() => NOW,
			() => 'claim-token-pdf',
			undefined,
			pdfStore,
			pdfEvidenceStore
		);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ claimed: 1, published: 1, integrityFailed: 0 });
		expect(store.publishCalls).toHaveLength(1);
		expect(pdfStore.calls).toHaveLength(1);
		expect(pdfStore.calls[0]).toMatchObject({
			envelopeId: ENVELOPE_ID
		});
		expect(pdfStore.calls[0].pdfSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(pdfStore.calls[0].pdfManifestSha256).toMatch(/^[a-f0-9]{64}$/);
		await expect(publishedPdfManifest(objects, pdfStore)).resolves.toMatchObject({
			artifactKind: 'evidence-summary-v1',
			appendixFirstPage: null
		});
	});

	it('publishes the executed agreement with the signed values drawn on the sent documents', async () => {
		const scenario = await executedScenario();

		const result = await scenario.service.publishPendingCompletionArtifacts();

		expect(result).toMatchObject({ claimed: 1, published: 1, integrityFailed: 0 });
		expect(scenario.pdfStore.calls).toHaveLength(1);
		const pdfManifest = await publishedPdfManifest(scenario.objects, scenario.pdfStore);
		expect(pdfManifest).toMatchObject({
			artifactKind: 'executed-agreement-v1',
			schema: COMPLETION_PDF_MANIFEST_SCHEMA
		});
		expect(pdfManifest.fields[0].geometry).toMatchObject({
			documentId: MARKDOWN_DOCUMENT_ID,
			page: 1,
			x: 0.1,
			y: 0.6
		});
		// The agreement's own pages come first and the evidence summary follows.
		expect(pdfManifest.appendixFirstPage).toBeGreaterThan(1);
		expect(pdfManifest.pageCount).toBeGreaterThanOrEqual(pdfManifest.appendixFirstPage ?? 0);

		const pdfBytes = await readObject(scenario.objects, scenario.pdfStore.calls[0].pdfObjectKey);
		expect(await pageTextOf(pdfBytes, 1)).toContain('Agreement body');
		expect(await pageTextOf(pdfBytes, 1)).toContain('Alex Signer');
	});

	it('uses the exact immutable sent Markdown PDF bytes instead of rerendering the pinned source', async () => {
		const scenario = await executedScenario({ sentMarkdownContent: 'Frozen sent rendering' });

		const result = await scenario.service.publishPendingCompletionArtifacts();

		expect(result).toMatchObject({ claimed: 1, published: 1, integrityFailed: 0 });
		const pdfBytes = await readObject(scenario.objects, scenario.pdfStore.calls[0].pdfObjectKey);
		expect(await pageTextOf(pdfBytes, 1)).toContain('Frozen sent rendering');
		expect(await pageTextOf(pdfBytes, 1)).not.toContain('Agreement body');
	});

	it('composites a drawn signature from its verified asset into the executed agreement', async () => {
		const png = drawnSignaturePng(48, 20);
		const digest = sha256Hex(png);
		const scenario = await executedScenario({
			valueJson: JSON.stringify(`sig:sha256:${digest}`),
			seedSignature: png
		});

		const result = await scenario.service.publishPendingCompletionArtifacts();

		expect(result).toMatchObject({ published: 1, integrityFailed: 0 });
		const pdfBytes = await readObject(scenario.objects, scenario.pdfStore.calls[0].pdfObjectKey);
		expect(new TextDecoder('latin1').decode(pdfBytes)).toContain('/Subtype /Image');
	});

	it('fails closed when a drawn signature asset is missing from the object store', async () => {
		const png = drawnSignaturePng(48, 20);
		const scenario = await executedScenario({
			valueJson: JSON.stringify(`sig:sha256:${sha256Hex(png)}`)
		});

		const result = await scenario.service.publishPendingCompletionArtifacts();

		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(scenario.store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});
		expect(scenario.pdfStore.calls).toHaveLength(0);
	});

	it('fails closed when a stored signature asset no longer matches its digest', async () => {
		const png = drawnSignaturePng(48, 20);
		const scenario = await executedScenario({
			valueJson: JSON.stringify(`sig:sha256:${sha256Hex(png)}`),
			seedSignature: drawnSignaturePng(64, 24),
			seedSignatureUnderDigestOf: png
		});

		const result = await scenario.service.publishPendingCompletionArtifacts();

		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(scenario.store.publishCalls).toHaveLength(0);
	});

	it('fails closed when a signed field lost its frozen geometry', async () => {
		const scenario = await executedScenario({ geometry: null });

		const result = await scenario.service.publishPendingCompletionArtifacts();

		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(scenario.store.failCalls[0]).toMatchObject({
			errorCode: 'completion_artifact_evidence_invalid',
			retryable: false
		});
	});

	it('fails closed when a placement row geometry differs from the hash-chained event', async () => {
		const scenario = await executedScenario({
			geometry: { ...FIELD_GEOMETRY, x: FIELD_GEOMETRY.x + 0.05 }
		});

		const result = await scenario.service.publishPendingCompletionArtifacts();

		expect(result).toMatchObject({ integrityFailed: 1, published: 0 });
		expect(scenario.store.publishCalls).toHaveLength(0);
		expect(scenario.pdfStore.calls).toHaveLength(0);
	});

	it('republishes byte-identical executed agreement bytes for the same evidence', async () => {
		const first = await executedScenario();
		const second = await executedScenario();

		await first.service.publishPendingCompletionArtifacts();
		await second.service.publishPendingCompletionArtifacts();

		expect(first.pdfStore.calls[0].pdfSha256).toBe(second.pdfStore.calls[0].pdfSha256);
		expect(first.pdfStore.calls[0].pdfManifestSha256).toBe(
			second.pdfStore.calls[0].pdfManifestSha256
		);
	});

	it('classifies a missing draft archive as a non-retryable integrity failure', async () => {
		const store = new FakeCompletionArtifactStore();
		const objects = new InMemoryObjectStore();
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
		const objects = new InMemoryObjectStore();
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
		// envelope's verified archive is read once, and only its json+markdown
		// artifacts are written.
		expect(objects.putCallsByKey.size).toBe(2);
		for (const key of objects.putCallsByKey.keys()) {
			expect(key).toContain(`/envelopes/${ENVELOPE_ID}/`);
			expect(key).not.toContain('envelope-corrupt');
		}
		expect(objects.getCalls).toBe(1);
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
