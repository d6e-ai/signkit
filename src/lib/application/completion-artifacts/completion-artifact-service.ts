import { hashAuditEventV3 } from '$lib/domain/audit';
import {
	DraftIntegrityError,
	readImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import {
	documentSetHash,
	parseDocumentSet,
	type DocumentSetLeaf,
	type DocumentSetManifest
} from '$lib/domain/document-set';
import { isMarkdownPath } from '$lib/domain/envelope';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import { newOpaqueToken, type OpaqueTokenGenerator } from '$lib/security/opaque-token';
import type { DraftDocument, DraftRepository } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import type {
	EnvelopeSentDocumentStore,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import type {
	CompletionPdfEvidenceStore,
	CompletionPdfFieldGeometry
} from '$lib/ports/completion-pdf-evidence-store';
import {
	boundCompletionArtifactPdfRepairClaimLimit,
	MAX_COMPLETION_ARTIFACT_PDF_REPAIR_DISCOVERY_BATCH,
	type ClaimedCompletionArtifactPdfRepair,
	type CompletionArtifactPdfRepairStore,
	type FailCompletionArtifactPdfRepairResult
} from '$lib/ports/completion-artifact-pdf-repair-store';
import {
	boundCompletionArtifactClaimLimit,
	CompletionArtifactBoundExceededError,
	MAX_COMPLETION_ARTIFACT_CLAIM_BATCH,
	MAX_COMPLETION_ARTIFACT_DISCOVERY_BATCH,
	sanitizeCompletionArtifactErrorCode,
	type ClaimedCompletionArtifactJob,
	type CompletionArtifactPdfMetadata,
	type CompletionArtifactStore,
	type CompletionEvidence,
	type CompletionEvidenceAuditEvent,
	type CompletionEvidenceField,
	type FailCompletionArtifactResult,
	type PublishCompletionArtifactResult
} from '$lib/ports/completion-artifact-store';
import {
	buildCompletionManifest,
	canonicalManifestJson,
	COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE,
	CompletionArtifactIntegrityError,
	gzipCompletionArtifact,
	renderCompletionMarkdown,
	sha256Hex,
	sha256TextHex,
	type CompletionManifestDocument,
	type CompletionManifestV1
} from './completion-manifest';
import {
	buildCompletionPdfManifest,
	buildCompletionPdfPages,
	canonicalPdfManifestJson,
	CompletionPdfBoundExceededError,
	renderCompletionPdf
} from './completion-pdf';
import { SentDocumentPdfError } from '$lib/application/documents/sent-document-pdf';
import {
	ExecutedPdfBoundExceededError,
	ExecutedPdfIntegrityError,
	type ExecutedPdfResult
} from './executed-pdf';
import { assembleExecutedAgreementPdf } from './executed-pdf-assembly';
import { verifyImmutableObject } from './exact-object-stream';
import { verifyAuditEventRecord } from './audit-event-integrity';

export const COMPLETION_ARTIFACT_CLAIM_LEASE_MS: number = 5 * 60 * 1000;
export const COMPLETION_ARTIFACT_RETRY_BASE_DELAY_MS: number = 30_000;
export const COMPLETION_ARTIFACT_RETRY_MAX_DELAY_MS: number = 6 * 60 * 60 * 1000;
export const MAX_COMPLETION_ARTIFACT_ATTEMPTS: number = 10;
const COMPLETION_ARTIFACT_CONCURRENCY: number = 3;
const JSON_CONTENT_TYPE: string = 'application/vnd.signkit.completion-manifest+json.gz';
const MARKDOWN_CONTENT_TYPE: string = 'application/vnd.signkit.completion-manifest+markdown.gz';
const PDF_CONTENT_TYPE: string = 'application/pdf';
const PDF_MANIFEST_CONTENT_TYPE: string = 'application/vnd.signkit.completion-pdf-manifest+json.gz';

export type CompletionArtifactItemOutcome =
	| { envelopeId: string; outcome: 'published' }
	| { envelopeId: string; outcome: 'stale' }
	| {
			envelopeId: string;
			outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed';
			errorCode: string;
	  };

export interface CompletionArtifactBatchResult {
	claimed: number;
	published: number;
	retryableFailed: number;
	permanentlyFailed: number;
	integrityFailed: number;
	stale: number;
	outcomes: readonly CompletionArtifactItemOutcome[];
}

/**
 * Discovers `completed` envelopes without a published artifact through a
 * leased job table (never the hot recipient sign/approve transactions),
 * deterministically rebuilds the canonical manifest from the pinned Git
 * revision plus SQL evidence, persists content-addressed JSON/Markdown gzip
 * artifacts, and publishes the pointer, optional PDF pointer, receipt, job
 * transition, and audit event atomically. The same drain then works a bounded
 * PDF repair batch for envelopes already published without a PDF pointer.
 */
export class CompletionArtifactPublicationService {
	readonly #store: CompletionArtifactStore;
	readonly #objects: ObjectStore;
	readonly #repository: DraftRepository;
	readonly #now: () => Date;
	readonly #newClaimToken: OpaqueTokenGenerator;
	readonly #newId: UuidV7Generator;
	readonly #pdfStore: CompletionArtifactPdfStore | null;
	readonly #pdfEvidenceStore: CompletionPdfEvidenceStore | null;
	readonly #sentDocuments: EnvelopeSentDocumentStore | null;
	readonly #pdfRepairStore: CompletionArtifactPdfRepairStore | null;

	constructor(
		store: CompletionArtifactStore,
		objects: ObjectStore,
		repository: DraftRepository,
		now: () => Date = (): Date => new Date(),
		// A lease token is opaque unguessable material, never a row identifier:
		// 256 random bits with no embedded creation time.
		newClaimToken: OpaqueTokenGenerator = newOpaqueToken,
		newId: UuidV7Generator = newUuidV7,
		// Optional: when omitted, PDF rendering is skipped entirely and only
		// the JSON/Markdown manifest (Slice A) is published. When present, the
		// PDF pointer is published atomically with the manifest. Envelopes
		// published without one are backfilled by the PDF repair queue, which
		// runs only when `pdfRepairStore` is also wired and never touches the
		// manifest publication this constructor's other parameters govern.
		pdfStore: CompletionArtifactPdfStore | null = null,
		pdfEvidenceStore: CompletionPdfEvidenceStore | null = null,
		sentDocuments: EnvelopeSentDocumentStore | null = null,
		pdfRepairStore: CompletionArtifactPdfRepairStore | null = null
	) {
		this.#store = store;
		this.#objects = objects;
		this.#repository = repository;
		this.#now = now;
		this.#newClaimToken = newClaimToken;
		this.#newId = newId;
		this.#pdfStore = pdfStore;
		this.#pdfEvidenceStore = pdfEvidenceStore;
		this.#sentDocuments = sentDocuments;
		this.#pdfRepairStore = pdfRepairStore;
	}

	async publishPendingCompletionArtifacts(
		limit: number = MAX_COMPLETION_ARTIFACT_CLAIM_BATCH
	): Promise<CompletionArtifactBatchResult> {
		const claimedAt: Date = this.#now();
		const claimToken: string = this.#newClaimToken();
		const claims: readonly ClaimedCompletionArtifactJob[] =
			await this.#store.claimPendingCompletionArtifacts({
				claimToken,
				claimedAt: claimedAt.toISOString(),
				staleBefore: new Date(
					claimedAt.valueOf() - COMPLETION_ARTIFACT_CLAIM_LEASE_MS
				).toISOString(),
				discoveryLimit: MAX_COMPLETION_ARTIFACT_DISCOVERY_BATCH,
				claimLimit: boundCompletionArtifactClaimLimit(limit)
			});
		const outcomes: CompletionArtifactItemOutcome[] = [];
		for (
			let offset: number = 0;
			offset < claims.length;
			offset += COMPLETION_ARTIFACT_CONCURRENCY
		) {
			const chunk: readonly ClaimedCompletionArtifactJob[] = claims.slice(
				offset,
				offset + COMPLETION_ARTIFACT_CONCURRENCY
			);
			const settled: readonly PromiseSettledResult<CompletionArtifactItemOutcome>[] =
				await Promise.allSettled(
					chunk.map((claim: ClaimedCompletionArtifactJob) =>
						this.#publishClaim(claim, claimToken, claimedAt)
					)
				);
			outcomes.push(
				...settled.map(
					(
						result: PromiseSettledResult<CompletionArtifactItemOutcome>,
						index: number
					): CompletionArtifactItemOutcome =>
						result.status === 'fulfilled'
							? result.value
							: {
									envelopeId: chunk[index].envelopeId,
									outcome: 'retryable_failed',
									errorCode: 'completion_artifact_store_unavailable'
								}
				)
			);
		}
		const repairOutcomes: readonly CompletionArtifactItemOutcome[] =
			await this.#repairPendingPdfs();
		return summarize(claims.length + repairOutcomes.length, [...outcomes, ...repairOutcomes]);
	}

	async #publishClaim(
		claim: ClaimedCompletionArtifactJob,
		claimToken: string,
		now: Date
	): Promise<CompletionArtifactItemOutcome> {
		const refreshed: ClaimedCompletionArtifactJob | null =
			await this.#store.readClaimedCompletionArtifact({
				envelopeId: claim.envelopeId,
				claimToken
			});
		if (refreshed === null) return { envelopeId: claim.envelopeId, outcome: 'stale' };
		claim = refreshed;

		try {
			// A completed envelope that is missing (or only partially has) its
			// repository pointer is corrupt data, isolated to this one row: the
			// row mapping deliberately never throws for it (see toClaimedJob in
			// both adapters), so this is the single place that turns it into a
			// fail-closed, non-retryable outcome for only this envelope, leaving
			// every other claim in the same batch unaffected.
			assertClaimedPointerPresent(claim);
			const evidence: CompletionEvidence = await this.#store.readCompletionEvidence(
				claim.envelopeId
			);
			await verifyFieldValueIntegrity(evidence.fields);
			const verified = await readImmutableDraftRevision(
				{
					envelopeId: claim.envelopeId,
					commitSha: claim.sentCommitSha,
					archiveKey: claim.repositoryArchiveKey,
					archiveSha256: claim.repositoryArchiveSha256
				},
				this.#objects,
				this.#repository
			);
			let pinnedManifestJson: string | null;
			try {
				pinnedManifestJson = await this.#repository.readManifest(
					verified.archive,
					claim.sentCommitSha
				);
			} catch {
				throw new DraftIntegrityError('Pinned draft repository failed Git verification');
			}
			const pinnedDocumentSet: DocumentSetManifest | null =
				pinnedManifestJson === null ? null : parsePinnedDocumentSet(pinnedManifestJson);
			const { documents: manifestDocuments, documentSetHash: pinnedDocumentSetHash } =
				await completionDocumentsFromRevision(verified.documents, pinnedDocumentSet);
			const manifest: CompletionManifestV1 = await buildCompletionManifest({
				envelopeId: claim.envelopeId,
				title: claim.envelopeTitle,
				sentCommitSha: claim.sentCommitSha,
				draftArchiveSha256: claim.repositoryArchiveSha256,
				fieldGeneration: claim.fieldGeneration,
				...(pinnedDocumentSetHash === undefined ? {} : { documentSetHash: pinnedDocumentSetHash }),
				documents: manifestDocuments,
				recipients: evidence.recipients,
				fields: evidence.fields,
				auditEvents: evidence.auditEvents
			});
			const manifestJson: string = canonicalManifestJson(manifest);
			const manifestSha256: string = await sha256TextHex(manifestJson);
			const jsonGzip: Uint8Array = gzipCompletionArtifact(manifestJson);
			const jsonSha256: string = await sha256Hex(jsonGzip);
			const markdown: string = renderCompletionMarkdown(manifest);
			const markdownGzip: Uint8Array = gzipCompletionArtifact(markdown);
			const markdownSha256: string = await sha256Hex(markdownGzip);
			const jsonKey: string = completionArtifactObjectKey(claim.envelopeId, 'json', jsonSha256);
			const markdownKey: string = completionArtifactObjectKey(
				claim.envelopeId,
				'markdown',
				markdownSha256
			);
			await this.#persistImmutable(jsonKey, jsonGzip, jsonSha256, JSON_CONTENT_TYPE);
			await this.#persistImmutable(
				markdownKey,
				markdownGzip,
				markdownSha256,
				MARKDOWN_CONTENT_TYPE
			);

			const anchor: CompletionEvidenceAuditEvent =
				evidence.auditEvents[evidence.auditEvents.length - 1];
			const auditPayload = {
				manifestSha256,
				jsonSha256,
				markdownSha256,
				sentCommitSha: claim.sentCommitSha,
				fieldGeneration: claim.fieldGeneration,
				publishedAt: now.toISOString()
			};
			const auditPayloadJson: string = JSON.stringify(auditPayload);
			// The durable publication receipt, not a derivation, proves a safe
			// in-flight replay; a separate attempt already differs by its own
			// publication timestamp, so minting this adds no new failure mode.
			const auditEventId: string = this.#newId();
			const auditEventHash: string = await hashAuditEventV3(
				{
					sequence: anchor.sequence + 1,
					eventType: COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE,
					actorType: 'system',
					actorId: 'completion-artifact-worker',
					occurredAt: now.toISOString(),
					payload: auditPayload,
					previousHash: anchor.eventHash
				},
				{ envelopeId: claim.envelopeId }
			);

			const pdf: CompletionArtifactPdfMetadata | null =
				this.#pdfStore !== null && this.#pdfEvidenceStore !== null
					? await this.#composePdfMetadata({
							claim,
							evidence,
							verifiedDocuments: verified.documents,
							pinnedDocumentSet,
							manifest,
							manifestSha256
						})
					: null;

			const publish: PublishCompletionArtifactResult = await this.#store.publishCompletionArtifact({
				envelopeId: claim.envelopeId,
				claimToken,
				sentCommitSha: claim.sentCommitSha,
				fieldGeneration: claim.fieldGeneration,
				anchorAuditEventId: anchor.id,
				expectedAuditSequence: anchor.sequence,
				previousAuditHash: anchor.eventHash,
				manifestSha256,
				jsonObjectKey: jsonKey,
				jsonSha256,
				markdownObjectKey: markdownKey,
				markdownSha256,
				updatedAt: now.toISOString(),
				auditEventId,
				auditEventHash,
				auditPayloadJson,
				pdf
			});
			if (publish.outcome === 'published' || publish.outcome === 'replayed') {
				return { envelopeId: claim.envelopeId, outcome: 'published' };
			}
			if (publish.outcome === 'stale') return { envelopeId: claim.envelopeId, outcome: 'stale' };
			return this.#finishFailure(
				claim,
				claimToken,
				'completion_artifact_integrity_conflict',
				false,
				now,
				'integrity_failed'
			);
		} catch (error: unknown) {
			// Order matters: CompletionArtifactBoundExceededError is a subclass of
			// CompletionArtifactIntegrityError, so it must be checked first to get
			// its own operator-safe error code rather than the generic one. R2/S3
			// are strongly consistent for these immutable pointers, so a
			// DraftIntegrityError from readImmutableDraftRevision (missing object,
			// SHA mismatch, scope mismatch, size, or Git verification failure) is
			// exactly as much an integrity failure here as our own checks.
			if (
				error instanceof CompletionArtifactBoundExceededError ||
				error instanceof CompletionPdfBoundExceededError
			) {
				return this.#finishFailure(
					claim,
					claimToken,
					'completion_artifact_evidence_too_large',
					false,
					now,
					'integrity_failed'
				);
			}
			const integrity: boolean =
				error instanceof CompletionArtifactIntegrityError || error instanceof DraftIntegrityError;
			return this.#finishFailure(
				claim,
				claimToken,
				integrity ? 'completion_artifact_evidence_invalid' : 'completion_artifact_build_failed',
				!integrity,
				now,
				integrity ? 'integrity_failed' : 'retryable_failed'
			);
		}
	}

	/**
	 * Composes the executed agreement for envelopes sent with a document set.
	 *
	 * Returns `null` only for legacy envelopes whose sent revision predates
	 * per-document publication: their fields are scoped to a Markdown path and
	 * were never given page geometry, so there is nothing to execute against
	 * and the evidence summary remains their PDF artifact. Every other failure
	 * — a missing signature asset, a field without geometry, a document whose
	 * bytes no longer verify — propagates and fails the publication closed.
	 */
	async #executeAgreement(input: {
		claim: ClaimedCompletionArtifactJob & {
			sentCommitSha: string;
			repositoryArchiveKey: string;
			repositoryArchiveSha256: string;
		};
		documentSet: DocumentSetManifest | null;
		documents: readonly DraftDocument[];
		fields: readonly CompletionEvidenceField[];
		auditEvents: readonly CompletionEvidenceAuditEvent[];
		fieldGeometry: readonly CompletionPdfFieldGeometry[];
		appendixPdfBytes: Uint8Array;
	}): Promise<ExecutedPdfResult | null> {
		if (input.documentSet === null) return null;
		if (this.#sentDocuments === null) {
			throw new CompletionArtifactIntegrityError(
				'Executed agreement PDF requires the immutable sent document store'
			);
		}
		const sentDocumentSet: SentDocumentSetPointer | null = await this.#sentDocuments.findSet(
			input.claim.envelopeId,
			input.claim.sentCommitSha
		);
		if (sentDocumentSet === null) {
			throw new CompletionArtifactIntegrityError(
				'Executed agreement PDF is missing its immutable sent document set'
			);
		}
		try {
			return await assembleExecutedAgreementPdf({
				objects: this.#objects,
				envelopeId: input.claim.envelopeId,
				sentCommitSha: input.claim.sentCommitSha,
				documentSet: input.documentSet,
				sentDocumentSet,
				auditEvents: input.auditEvents,
				fieldGeneration: input.claim.fieldGeneration,
				fields: input.fields,
				fieldGeometry: input.fieldGeometry,
				appendixPdfBytes: input.appendixPdfBytes
			});
		} catch (error: unknown) {
			if (error instanceof ExecutedPdfBoundExceededError) {
				throw new CompletionPdfBoundExceededError('Executed agreement PDF exceeds a size limit');
			}
			if (error instanceof ExecutedPdfIntegrityError || error instanceof SentDocumentPdfError) {
				throw new CompletionArtifactIntegrityError(
					'Executed agreement PDF could not be produced from the verified evidence'
				);
			}
			throw error;
		}
	}

	async #composePdfMetadata(input: {
		claim: ClaimedCompletionArtifactJob & {
			sentCommitSha: string;
			repositoryArchiveKey: string;
			repositoryArchiveSha256: string;
		};
		evidence: CompletionEvidence;
		verifiedDocuments: readonly DraftDocument[];
		pinnedDocumentSet: DocumentSetManifest | null;
		manifest: CompletionManifestV1;
		manifestSha256: string;
	}): Promise<CompletionArtifactPdfMetadata> {
		if (this.#pdfEvidenceStore === null) {
			throw new CompletionArtifactIntegrityError(
				'Completion artifact PDF composition requires field geometry evidence'
			);
		}
		const fieldGeometry: readonly CompletionPdfFieldGeometry[] =
			await this.#pdfEvidenceStore.readFieldGeometry(input.claim.envelopeId);
		const pages = buildCompletionPdfPages(input.manifest, input.verifiedDocuments, fieldGeometry);
		const evidenceSummaryPdf: Uint8Array = renderCompletionPdf(pages);
		const executed: ExecutedPdfResult | null = await this.#executeAgreement({
			claim: input.claim,
			documentSet: input.pinnedDocumentSet,
			documents: input.verifiedDocuments,
			fields: input.evidence.fields,
			auditEvents: input.evidence.auditEvents,
			fieldGeometry,
			appendixPdfBytes: evidenceSummaryPdf
		});
		const pdfBytes: Uint8Array = executed?.bytes ?? evidenceSummaryPdf;
		const pdfSha256: string = await sha256Hex(pdfBytes);
		const pdfKey: string = completionArtifactObjectKey(input.claim.envelopeId, 'pdf', pdfSha256);
		await this.#persistImmutable(pdfKey, pdfBytes, pdfSha256, PDF_CONTENT_TYPE);

		const pdfManifest = await buildCompletionPdfManifest({
			manifest: input.manifest,
			manifestSha256: input.manifestSha256,
			pdfBytes,
			fieldGeometry,
			artifactKind: executed === null ? 'evidence-summary-v1' : 'executed-agreement-v1',
			pageCount: executed?.pageCount ?? pages.length,
			appendixFirstPage: executed?.appendixFirstPage ?? null,
			...(executed === null
				? {}
				: {
						documentPages: new Map(
							executed.documents.map((document) => [
								document.documentId,
								{ firstPage: document.firstPage, lastPage: document.lastPage }
							])
						)
					})
		});
		const pdfManifestJson: string = canonicalPdfManifestJson(pdfManifest);
		const pdfManifestGzip: Uint8Array = gzipCompletionArtifact(pdfManifestJson);
		const pdfManifestSha256: string = await sha256Hex(pdfManifestGzip);
		const pdfManifestKey: string = completionArtifactObjectKey(
			input.claim.envelopeId,
			'pdf-manifest',
			pdfManifestSha256
		);
		await this.#persistImmutable(
			pdfManifestKey,
			pdfManifestGzip,
			pdfManifestSha256,
			PDF_MANIFEST_CONTENT_TYPE
		);
		return {
			pdfObjectKey: pdfKey,
			pdfSha256,
			pdfByteSize: pdfBytes.byteLength,
			pdfManifestObjectKey: pdfManifestKey,
			pdfManifestSha256
		};
	}

	async #repairPendingPdfs(): Promise<readonly CompletionArtifactItemOutcome[]> {
		if (
			this.#pdfStore === null ||
			this.#pdfEvidenceStore === null ||
			this.#pdfRepairStore === null
		) {
			return [];
		}
		const claimedAt: Date = this.#now();
		const claimToken: string = this.#newClaimToken();
		let claims: readonly ClaimedCompletionArtifactPdfRepair[];
		try {
			claims = await this.#pdfRepairStore.claimPendingPdfRepairs({
				claimToken,
				claimedAt: claimedAt.toISOString(),
				staleBefore: new Date(
					claimedAt.valueOf() - COMPLETION_ARTIFACT_CLAIM_LEASE_MS
				).toISOString(),
				discoveryLimit: MAX_COMPLETION_ARTIFACT_PDF_REPAIR_DISCOVERY_BATCH,
				claimLimit: boundCompletionArtifactPdfRepairClaimLimit(1)
			});
		} catch (error: unknown) {
			// The primary batch already committed its own outcomes; a repair
			// queue outage must not discard them. Nothing was claimed, so the
			// next drain simply tries again.
			console.error(
				JSON.stringify({
					event: 'completion_artifact_pdf_repair_claim_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return [];
		}
		const outcomes: CompletionArtifactItemOutcome[] = [];
		for (const claim of claims) {
			try {
				outcomes.push(await this.#repairClaim(claim, claimToken, claimedAt));
			} catch {
				// The lease expires and a later drain reclaims it.
				outcomes.push({
					envelopeId: claim.envelopeId,
					outcome: 'retryable_failed',
					errorCode: 'completion_artifact_store_unavailable'
				});
			}
		}
		return outcomes;
	}

	async #repairClaim(
		claim: ClaimedCompletionArtifactPdfRepair,
		claimToken: string,
		now: Date
	): Promise<CompletionArtifactItemOutcome> {
		if (this.#pdfRepairStore === null) {
			return { envelopeId: claim.envelopeId, outcome: 'stale' };
		}
		const refreshed: ClaimedCompletionArtifactPdfRepair | null =
			await this.#pdfRepairStore.readClaimedPdfRepair({
				envelopeId: claim.envelopeId,
				claimToken
			});
		if (refreshed === null) return { envelopeId: claim.envelopeId, outcome: 'stale' };
		claim = refreshed;

		try {
			assertClaimedPointerPresent(claim);
			if (claim.auditHeadSequence < 2) {
				throw new CompletionArtifactIntegrityError(
					'Completion artifact PDF repair is missing its publication audit head'
				);
			}
			const throughSequence: number = claim.auditHeadSequence - 1;
			const evidence: CompletionEvidence = await this.#store.readCompletionEvidence(
				claim.envelopeId,
				{ throughSequence }
			);
			const publicationEvidence: CompletionEvidence = await this.#store.readCompletionEvidence(
				claim.envelopeId,
				{ throughSequence: claim.auditHeadSequence }
			);
			await verifyOriginalPublication(claim, evidence, publicationEvidence);
			await verifyFieldValueIntegrity(evidence.fields);
			const verified = await readImmutableDraftRevision(
				{
					envelopeId: claim.envelopeId,
					commitSha: claim.sentCommitSha,
					archiveKey: claim.repositoryArchiveKey,
					archiveSha256: claim.repositoryArchiveSha256
				},
				this.#objects,
				this.#repository
			);
			let pinnedManifestJson: string | null;
			try {
				pinnedManifestJson = await this.#repository.readManifest(
					verified.archive,
					claim.sentCommitSha
				);
			} catch {
				throw new DraftIntegrityError('Pinned draft repository failed Git verification');
			}
			const pinnedDocumentSet: DocumentSetManifest | null =
				pinnedManifestJson === null ? null : parsePinnedDocumentSet(pinnedManifestJson);
			const { documents: manifestDocuments, documentSetHash: pinnedDocumentSetHash } =
				await completionDocumentsFromRevision(verified.documents, pinnedDocumentSet);
			const manifest: CompletionManifestV1 = await buildCompletionManifest({
				envelopeId: claim.envelopeId,
				title: claim.envelopeTitle,
				sentCommitSha: claim.sentCommitSha,
				draftArchiveSha256: claim.repositoryArchiveSha256,
				fieldGeneration: claim.fieldGeneration,
				...(pinnedDocumentSetHash === undefined ? {} : { documentSetHash: pinnedDocumentSetHash }),
				documents: manifestDocuments,
				recipients: evidence.recipients,
				fields: evidence.fields,
				auditEvents: evidence.auditEvents
			});
			const manifestJson: string = canonicalManifestJson(manifest);
			const manifestSha256: string = await sha256TextHex(manifestJson);
			const jsonGzip: Uint8Array = gzipCompletionArtifact(manifestJson);
			const jsonSha256: string = await sha256Hex(jsonGzip);
			const markdown: string = renderCompletionMarkdown(manifest);
			const markdownGzip: Uint8Array = gzipCompletionArtifact(markdown);
			const markdownSha256: string = await sha256Hex(markdownGzip);
			if (
				manifestSha256 !== claim.manifestSha256 ||
				jsonSha256 !== claim.jsonSha256 ||
				markdownSha256 !== claim.markdownSha256
			) {
				throw new CompletionArtifactIntegrityError(
					'Completion artifact PDF repair reproduced different manifest bytes'
				);
			}
			// The published JSON/Markdown objects are never rewritten by repair:
			// they must already hold exactly the reproduced bytes.
			await this.#requirePublishedObject(claim.jsonObjectKey, jsonSha256, jsonGzip.byteLength);
			await this.#requirePublishedObject(
				claim.markdownObjectKey,
				markdownSha256,
				markdownGzip.byteLength
			);
			const pdf: CompletionArtifactPdfMetadata = await this.#composePdfMetadata({
				claim,
				evidence,
				verifiedDocuments: verified.documents,
				pinnedDocumentSet,
				manifest,
				manifestSha256
			});
			const complete = await this.#pdfRepairStore.completePdfRepair({
				envelopeId: claim.envelopeId,
				claimToken,
				expectedManifestSha256: claim.manifestSha256,
				pdf,
				updatedAt: now.toISOString()
			});
			if (complete.outcome === 'repaired' || complete.outcome === 'replayed') {
				return { envelopeId: claim.envelopeId, outcome: 'published' };
			}
			if (complete.outcome === 'stale') {
				return { envelopeId: claim.envelopeId, outcome: 'stale' };
			}
			return this.#finishPdfRepairFailure(
				claim,
				claimToken,
				'completion_artifact_integrity_conflict',
				false,
				now,
				'integrity_failed'
			);
		} catch (error: unknown) {
			if (
				error instanceof CompletionArtifactBoundExceededError ||
				error instanceof CompletionPdfBoundExceededError
			) {
				return this.#finishPdfRepairFailure(
					claim,
					claimToken,
					'completion_artifact_evidence_too_large',
					false,
					now,
					'integrity_failed'
				);
			}
			const integrity: boolean =
				error instanceof CompletionArtifactIntegrityError || error instanceof DraftIntegrityError;
			return this.#finishPdfRepairFailure(
				claim,
				claimToken,
				integrity ? 'completion_artifact_evidence_invalid' : 'completion_artifact_build_failed',
				!integrity,
				now,
				integrity ? 'integrity_failed' : 'retryable_failed'
			);
		}
	}

	async #finishPdfRepairFailure(
		claim: ClaimedCompletionArtifactPdfRepair,
		claimToken: string,
		errorCode: string,
		retryable: boolean,
		now: Date,
		outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed'
	): Promise<CompletionArtifactItemOutcome> {
		if (this.#pdfRepairStore === null) {
			return { envelopeId: claim.envelopeId, outcome: 'stale' };
		}
		const attemptsExhausted: boolean =
			retryable && claim.attempts >= MAX_COMPLETION_ARTIFACT_ATTEMPTS;
		const willRetry: boolean = retryable && !attemptsExhausted;
		const safeCode: string = sanitizeCompletionArtifactErrorCode(
			attemptsExhausted ? 'completion_artifact_pdf_repair_attempts_exhausted' : errorCode
		);
		const failure: FailCompletionArtifactPdfRepairResult = await this.#pdfRepairStore.failPdfRepair(
			{
				envelopeId: claim.envelopeId,
				claimToken,
				errorCode: safeCode,
				retryable: willRetry,
				nextAvailableAt: willRetry
					? completionArtifactRetryAvailableAt(now, claim.attempts)
					: now.toISOString(),
				failedAt: now.toISOString()
			}
		);
		if (failure.outcome === 'stale') return { envelopeId: claim.envelopeId, outcome: 'stale' };
		return {
			envelopeId: claim.envelopeId,
			outcome: attemptsExhausted ? 'permanently_failed' : outcome,
			errorCode: safeCode
		};
	}

	async #persistImmutable(
		key: string,
		bytes: Uint8Array,
		sha256: string,
		contentType: string
	): Promise<void> {
		try {
			const stored: ObjectMetadata = await this.#objects.putImmutable(key, {
				contentType,
				body: bytes,
				sha256,
				metadata: { format: 'signkit-completion-artifact-v1' }
			});
			if (stored.key !== key || stored.size !== bytes.byteLength || stored.sha256 !== sha256) {
				throw new CompletionArtifactIntegrityError(
					'Object store did not confirm the immutable completion artifact'
				);
			}
		} catch (error: unknown) {
			// A provider can report a precondition failure, or lose the response after
			// accepting the write. Reuse is safe only after reading and hashing the
			// immutable object ourselves, exactly as draft archive persistence does.
			// An object that is simply missing, or that we failed to read back, is a
			// transient condition and stays retryable with the original error. An
			// object that DOES exist at this content-addressed key but holds
			// different bytes is a real conflict — content-addressing means that
			// should be cryptographically impossible for honest data — so it must
			// fail closed immediately rather than retry until attempts exhaust.
			const outcome: 'missing' | 'verified' | 'mismatched' = await this.#readAndVerify(
				key,
				sha256,
				bytes.byteLength
			);
			if (outcome === 'verified') return;
			if (outcome === 'mismatched') {
				throw new CompletionArtifactIntegrityError(
					'Object store already holds different bytes at this immutable content-addressed key'
				);
			}
			throw error;
		}
	}

	/**
	 * A published, DB-referenced object that is absent or differs is
	 * corruption, not a transient: fail closed. A provider read error still
	 * propagates and stays retryable.
	 */
	async #requirePublishedObject(key: string, sha256: string, size: number): Promise<void> {
		const outcome: 'missing' | 'verified' | 'mismatched' = await this.#readAndVerify(
			key,
			sha256,
			size
		);
		if (outcome !== 'verified') {
			throw new CompletionArtifactIntegrityError(
				'Published completion artifact object does not hold the reproduced bytes'
			);
		}
	}

	async #readAndVerify(
		key: string,
		expectedSha256: string,
		expectedSize: number
	): Promise<'missing' | 'verified' | 'mismatched'> {
		return verifyImmutableObject(this.#objects, key, expectedSha256, expectedSize);
	}

	async #finishFailure(
		claim: ClaimedCompletionArtifactJob,
		claimToken: string,
		errorCode: string,
		retryable: boolean,
		now: Date,
		outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed'
	): Promise<CompletionArtifactItemOutcome> {
		const attemptsExhausted: boolean =
			retryable && claim.attempts >= MAX_COMPLETION_ARTIFACT_ATTEMPTS;
		const willRetry: boolean = retryable && !attemptsExhausted;
		const safeCode: string = sanitizeCompletionArtifactErrorCode(
			attemptsExhausted ? 'completion_artifact_attempts_exhausted' : errorCode
		);
		const failure: FailCompletionArtifactResult = await this.#store.failCompletionArtifact({
			envelopeId: claim.envelopeId,
			claimToken,
			errorCode: safeCode,
			retryable: willRetry,
			nextAvailableAt: willRetry
				? completionArtifactRetryAvailableAt(now, claim.attempts)
				: now.toISOString(),
			failedAt: now.toISOString()
		});
		if (failure.outcome === 'stale') return { envelopeId: claim.envelopeId, outcome: 'stale' };
		return {
			envelopeId: claim.envelopeId,
			outcome: attemptsExhausted ? 'permanently_failed' : outcome,
			errorCode: safeCode
		};
	}
}

export function completionArtifactRetryAvailableAt(now: Date, attempts: number): string {
	const safeAttempts: number = Math.max(1, attempts);
	const exponent: number = Math.min(safeAttempts - 1, 10);
	const delayMs: number = Math.min(
		COMPLETION_ARTIFACT_RETRY_MAX_DELAY_MS,
		COMPLETION_ARTIFACT_RETRY_BASE_DELAY_MS * 2 ** exponent
	);
	return new Date(now.valueOf() + delayMs).toISOString();
}

export function completionArtifactObjectKey(
	envelopeId: string,
	kind: 'json' | 'markdown' | 'pdf' | 'pdf-manifest',
	sha256: string
): string {
	const extension: string =
		kind === 'json' || kind === 'pdf-manifest' ? 'json.gz' : kind === 'markdown' ? 'md.gz' : 'pdf';
	return `completion-artifacts/v1/envelopes/${encodeScopeSegment(envelopeId)}/sha256/${sha256}.${extension}`;
}

function summarize(
	claimed: number,
	outcomes: readonly CompletionArtifactItemOutcome[]
): CompletionArtifactBatchResult {
	let published: number = 0;
	let retryableFailed: number = 0;
	let permanentlyFailed: number = 0;
	let integrityFailed: number = 0;
	let stale: number = 0;
	for (const item of outcomes) {
		if (item.outcome === 'published') published += 1;
		else if (item.outcome === 'retryable_failed') retryableFailed += 1;
		else if (item.outcome === 'permanently_failed') permanentlyFailed += 1;
		else if (item.outcome === 'integrity_failed') integrityFailed += 1;
		else stale += 1;
	}
	return {
		claimed,
		published,
		retryableFailed,
		permanentlyFailed,
		integrityFailed,
		stale,
		outcomes
	};
}

function encodeScopeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

/**
 * A `completed` envelope should always have pinned its repository pointer
 * before completion, but the row mapping never enforces that (see
 * `toClaimedJob`), so this is the one place that does: all three fields must
 * be present together, or the claim fails closed as this envelope's own
 * integrity error. Format and instance-scope validation still happens in
 * `readImmutableDraftRevision`, unchanged, once presence is established here.
 */
function assertClaimedPointerPresent<
	T extends {
		sentCommitSha: string | null;
		repositoryArchiveKey: string | null;
		repositoryArchiveSha256: string | null;
	}
>(
	claim: T
): asserts claim is T & {
	sentCommitSha: string;
	repositoryArchiveKey: string;
	repositoryArchiveSha256: string;
} {
	if (
		claim.sentCommitSha === null ||
		claim.repositoryArchiveKey === null ||
		claim.repositoryArchiveSha256 === null
	) {
		throw new CompletionArtifactIntegrityError(
			'Claimed completion artifact envelope is missing its repository pointer'
		);
	}
}

async function verifyOriginalPublication(
	claim: ClaimedCompletionArtifactPdfRepair,
	prefix: CompletionEvidence,
	throughPublication: CompletionEvidence
): Promise<void> {
	const anchor: CompletionEvidenceAuditEvent | undefined =
		prefix.auditEvents[prefix.auditEvents.length - 1];
	if (
		anchor === undefined ||
		anchor.id !== claim.anchorAuditEventId ||
		anchor.sequence !== claim.auditHeadSequence - 1 ||
		anchor.eventType !== 'envelope.completed'
	) {
		throw new CompletionArtifactIntegrityError(
			'Completion artifact PDF repair evidence prefix is not the original completion anchor'
		);
	}
	const publication: CompletionEvidenceAuditEvent | undefined =
		throughPublication.auditEvents[throughPublication.auditEvents.length - 1];
	if (
		publication === undefined ||
		publication.id !== claim.auditEventId ||
		publication.sequence !== claim.auditHeadSequence ||
		publication.eventHash !== claim.auditHeadEventHash ||
		publication.eventType !== COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE ||
		publication.previousHash !== anchor.eventHash
	) {
		throw new CompletionArtifactIntegrityError(
			'Completion artifact PDF repair could not verify the original publication event'
		);
	}
	// Version-aware recompute (canonical payload, actor, timestamp, and hash),
	// so a publication written under an earlier hash version still verifies.
	const payload: unknown = await verifyAuditEventRecord(publication, {
		envelopeId: claim.envelopeId
	});
	if (typeof payload !== 'object' || payload === null) {
		throw new CompletionArtifactIntegrityError(
			'Completion artifact publication payload is not an object'
		);
	}
	const record: Record<string, unknown> = payload as Record<string, unknown>;
	if (
		record.manifestSha256 !== claim.manifestSha256 ||
		record.jsonSha256 !== claim.jsonSha256 ||
		record.markdownSha256 !== claim.markdownSha256 ||
		record.sentCommitSha !== claim.sentCommitSha ||
		record.fieldGeneration !== claim.fieldGeneration
	) {
		throw new CompletionArtifactIntegrityError(
			'Completion artifact publication payload does not match the stored pointer'
		);
	}
}

/**
 * Recompute SHA-256 over the exact persisted `field_value.value_json` string
 * and require it to equal the stored `value_sha256` before any artifact
 * object write. A mismatch means the value was tampered with (or corrupted)
 * after signing, so publication must fail closed rather than notarize it.
 */
async function verifyFieldValueIntegrity(
	fields: readonly CompletionEvidenceField[]
): Promise<void> {
	for (const field of fields) {
		const digest: string = await sha256TextHex(field.valueJson);
		if (digest !== field.valueSha256) {
			throw new CompletionArtifactIntegrityError(
				'Completion evidence field value does not match its persisted SHA-256'
			);
		}
	}
}

function parsePinnedDocumentSet(manifestJson: string): DocumentSetManifest {
	try {
		return parseDocumentSet(manifestJson);
	} catch {
		throw new CompletionArtifactIntegrityError('Completion document set is invalid');
	}
}

async function completionDocumentsFromRevision(
	documents: readonly DraftDocument[],
	manifest: DocumentSetManifest | null
): Promise<{
	documents: CompletionManifestDocument[];
	documentSetHash?: string;
}> {
	if (manifest === null) {
		const legacy: CompletionManifestDocument[] = [];
		for (const document of documents) {
			if (!isMarkdownPath(document.path)) continue;
			legacy.push({
				path: document.path,
				sha256: await sha256TextHex(document.content)
			});
		}
		return { documents: legacy };
	}
	const markdownByPath = new Map<string, DraftDocument>(
		documents.map((document: DraftDocument): [string, DraftDocument] => [document.path, document])
	);
	const mapped: CompletionManifestDocument[] = [];
	for (const leaf of manifest.documents) {
		mapped.push(await completionDocumentFromLeaf(leaf, markdownByPath));
	}
	return { documents: mapped, documentSetHash: await documentSetHash(manifest) };
}

async function completionDocumentFromLeaf(
	leaf: DocumentSetLeaf,
	markdownByPath: ReadonlyMap<string, DraftDocument>
): Promise<CompletionManifestDocument> {
	if (leaf.kind === 'pdf') {
		return {
			sha256: leaf.sha256,
			id: leaf.id,
			kind: 'pdf',
			position: leaf.position,
			title: leaf.title,
			byteSize: leaf.byteSize,
			pageCount: leaf.pageCount
		};
	}
	const content: DraftDocument | undefined = markdownByPath.get(leaf.path);
	if (content === undefined) {
		throw new CompletionArtifactIntegrityError('Completion markdown document is missing');
	}
	return {
		path: leaf.path,
		sha256: await sha256TextHex(content.content),
		id: leaf.id,
		kind: 'markdown',
		position: leaf.position,
		title: leaf.title
	};
}
