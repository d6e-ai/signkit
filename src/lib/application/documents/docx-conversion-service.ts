import { newUuidV7 } from '$lib/ids/uuid-v7';
import { newOpaqueToken } from '$lib/security/opaque-token';
import {
	boundDocxConversionClaimLimit,
	MAX_DOCX_CONVERSION_CLAIM_BATCH,
	sanitizeDocxConversionErrorCode,
	type ClaimedDocxConversionJob,
	type DocxConversionJob,
	type DocxExportJob,
	type DocxConversionStore,
	type EnqueueDocxConversionResult
} from '$lib/ports/docx-conversion-store';
import type { DraftActor, DraftRepository } from '$lib/ports/draft-repository';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { ObjectStore } from '$lib/ports/object-store';
import { DocxImportService } from '$lib/application/documents/docx-import-service';
import { exportPinnedDocx } from '$lib/application/documents/docx-export-service';
import {
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	DraftIntegrityError
} from '$lib/application/drafts/draft-persistence';
import {
	DocxImportError,
	NODE_DOCX_IMPORT_LIMITS,
	type DocxImportLimits
} from '$lib/adapters/documents/docx-import';
import { DocxExportError } from '$lib/adapters/documents/docx-export';
import { DocumentSetError } from '$lib/domain/document-set';

export const DOCX_MIME_TYPE: string =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOCX_CONVERSION_CLAIM_LEASE_MS: number = 5 * 60 * 1000;
export const DOCX_CONVERSION_RETRY_BASE_DELAY_MS: number = 30_000;
export const DOCX_CONVERSION_RETRY_MAX_DELAY_MS: number = 6 * 60 * 60 * 1000;
export const MAX_DOCX_CONVERSION_ATTEMPTS: number = 5;

export function docxImportSourceObjectKey(envelopeId: string, sha256: string): string {
	return `docx-conversions/v1/envelopes/${encodeScopeSegment(envelopeId)}/imports/${sha256}.docx`;
}

export function docxExportResultObjectKey(envelopeId: string, sha256: string): string {
	return `docx-conversions/v1/envelopes/${encodeScopeSegment(envelopeId)}/exports/${sha256}.docx`;
}

function encodeScopeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

export function docxConversionRetryAvailableAt(
	now: Date,
	attempts: number,
	baseDelayMs: number = DOCX_CONVERSION_RETRY_BASE_DELAY_MS,
	maxDelayMs: number = DOCX_CONVERSION_RETRY_MAX_DELAY_MS
): string {
	const safeAttempts: number = Math.max(1, attempts);
	const exponent: number = Math.min(safeAttempts - 1, 10);
	const delayMs: number = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
	return new Date(now.valueOf() + delayMs).toISOString();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export async function sha256String(value: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(value));
}

async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size: number = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maximumBytes) {
				await reader.cancel('Stream exceeded maximum byte limit');
				throw new DraftIntegrityError('Stream exceeded maximum byte limit');
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes: Uint8Array = new Uint8Array(size);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export interface EnqueueDocxImportInput {
	envelopeId: string;
	bytes: Uint8Array;
	targetPath: `documents/${string}.md`;
	expectedGeneration: number;
	actor: DraftActor;
	idempotencyKey: string;
	requestKey?: string;
	createdAt?: string;
}

export interface EnqueueDocxExportInput {
	envelopeId: string;
	requestKey?: string;
	sourceCommitSha?: string;
	sourceArchiveKey?: string;
	sourceArchiveSha256?: string;
	createdAt?: string;
}

export type DocxConversionItemOutcome =
	| { jobId: string; outcome: 'succeeded'; job: DocxConversionJob }
	| { jobId: string; outcome: 'stale' }
	| {
			jobId: string;
			outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed';
			errorCode: string;
	  };

export interface DocxConversionBatchResult {
	claimed: number;
	succeeded: number;
	failed: number;
	stale: number;
	items: readonly DocxConversionItemOutcome[];
}

export interface DocxConversionServiceOptions {
	store: DocxConversionStore;
	objects: ObjectStore;
	importService: Pick<DocxImportService, 'importAndCommit'>;
	draftRepository: DraftRepository;
	envelopes?: Pick<EnvelopeStore, 'findEnvelope'>;
	now?: () => Date;
	newId?: () => string;
	leaseMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	maxAttempts?: number;
	importLimits?: DocxImportLimits;
}

export class DocxConversionService {
	readonly #store: DocxConversionStore;
	readonly #objects: ObjectStore;
	readonly #importService: Pick<DocxImportService, 'importAndCommit'>;
	readonly #draftRepository: DraftRepository;
	readonly #envelopes?: Pick<EnvelopeStore, 'findEnvelope'>;
	readonly #now?: () => Date;
	readonly #newId: () => string;
	readonly #leaseMs: number;
	readonly #baseDelayMs: number;
	readonly #maxDelayMs: number;
	readonly #maxAttempts: number;
	readonly #importLimits: DocxImportLimits;

	constructor(options: DocxConversionServiceOptions) {
		this.#store = options.store;
		this.#objects = options.objects;
		this.#importService = options.importService;
		this.#draftRepository = options.draftRepository;
		this.#envelopes = options.envelopes;
		this.#now = options.now;
		this.#newId = options.newId ?? newUuidV7;
		this.#leaseMs = options.leaseMs ?? DOCX_CONVERSION_CLAIM_LEASE_MS;
		this.#baseDelayMs = options.baseDelayMs ?? DOCX_CONVERSION_RETRY_BASE_DELAY_MS;
		this.#maxDelayMs = options.maxDelayMs ?? DOCX_CONVERSION_RETRY_MAX_DELAY_MS;
		this.#maxAttempts = options.maxAttempts ?? MAX_DOCX_CONVERSION_ATTEMPTS;
		this.#importLimits = options.importLimits ?? NODE_DOCX_IMPORT_LIMITS;
	}

	async enqueueImport(input: EnqueueDocxImportInput): Promise<EnqueueDocxConversionResult> {
		const sourceSha256: string = await sha256Hex(input.bytes);
		const sourceByteSize: number = input.bytes.byteLength;
		const sourceObjectKey: string = docxImportSourceObjectKey(input.envelopeId, sourceSha256);
		const createdAt: string =
			input.createdAt ?? (this.#now ? this.#now() : new Date()).toISOString();
		const requestKey: string = input.requestKey ?? input.idempotencyKey;
		const requestFingerprint: string = await sha256String(
			JSON.stringify({
				envelopeId: input.envelopeId,
				direction: 'import',
				targetPath: input.targetPath,
				expectedGeneration: input.expectedGeneration,
				actor: input.actor,
				idempotencyKey: input.idempotencyKey,
				sourceSha256,
				sourceByteSize
			})
		);
		if (this.#store.findByRequestKey !== undefined) {
			const existing: DocxConversionJob | null = await this.#store.findByRequestKey(
				input.envelopeId,
				'import',
				requestKey
			);
			if (existing !== null) {
				return existing.requestFingerprint === requestFingerprint
					? { outcome: 'existing', job: existing }
					: { outcome: 'conflict' };
			}
		}
		if (this.#envelopes !== undefined) {
			const envelope = await this.#envelopes.findEnvelope(input.envelopeId);
			if (envelope === null) throw new DraftEnvelopeNotFoundError();
			if (envelope.status !== 'draft') throw new DraftEnvelopeImmutableError();
			if (envelope.repositoryGeneration !== input.expectedGeneration) {
				throw new DraftGenerationConflictError(input.expectedGeneration);
			}
		}

		await this.#persistImmutableDocx(sourceObjectKey, input.bytes, sourceSha256);

		return await this.#store.enqueueImport({
			id: this.#newId(),
			envelopeId: input.envelopeId,
			requestKey,
			requestFingerprint,
			sourceObjectKey,
			sourceSha256,
			sourceByteSize,
			targetPath: input.targetPath,
			expectedGeneration: input.expectedGeneration,
			actor: input.actor,
			idempotencyKey: input.idempotencyKey,
			createdAt
		});
	}

	async enqueueExport(input: EnqueueDocxExportInput): Promise<EnqueueDocxConversionResult> {
		let commitSha: string | null = input.sourceCommitSha ?? null;
		let archiveKey: string | null = input.sourceArchiveKey ?? null;
		let archiveSha256: string | null = input.sourceArchiveSha256 ?? null;

		if (commitSha === null || archiveKey === null || archiveSha256 === null) {
			if (this.#envelopes === undefined) {
				throw new Error(
					'Cannot resolve source commit and archive for DOCX export: envelope store not configured'
				);
			}
			const envelope = await this.#envelopes.findEnvelope(input.envelopeId);
			if (envelope === null) {
				throw new DraftEnvelopeNotFoundError();
			}
			commitSha = envelope.sentCommitSha ?? envelope.repositoryHead;
			archiveKey = envelope.repositoryArchiveKey;
			archiveSha256 = envelope.repositoryArchiveSha256;
			if (commitSha === null || archiveKey === null || archiveSha256 === null) {
				throw new DocxExportError(
					'empty_draft',
					'The envelope has no pinned Markdown revision to export as DOCX'
				);
			}
		}

		const createdAt: string =
			input.createdAt ?? (this.#now ? this.#now() : new Date()).toISOString();
		const requestKey: string = input.requestKey ?? `${commitSha}-${archiveSha256}`;
		const requestFingerprint: string = await sha256String(
			JSON.stringify({
				envelopeId: input.envelopeId,
				direction: 'export',
				sourceCommitSha: commitSha,
				sourceArchiveKey: archiveKey,
				sourceArchiveSha256: archiveSha256
			})
		);

		return await this.#store.enqueueExport({
			id: this.#newId(),
			envelopeId: input.envelopeId,
			requestKey,
			requestFingerprint,
			sourceCommitSha: commitSha,
			sourceArchiveKey: archiveKey,
			sourceArchiveSha256: archiveSha256,
			createdAt
		});
	}

	async processJob(jobId: string, options?: { now?: Date }): Promise<DocxConversionItemOutcome> {
		const now: Date = options?.now ?? (this.#now ? this.#now() : new Date());
		const claimToken: string = newOpaqueToken();
		const claimedAt: string = now.toISOString();
		const staleBefore: string = new Date(now.valueOf() - this.#leaseMs).toISOString();

		const claimed: readonly ClaimedDocxConversionJob[] = await this.#store.claim({
			claimToken,
			claimedAt,
			staleBefore,
			limit: 1,
			jobId
		});

		if (claimed.length === 0) {
			const existing: DocxConversionJob | null = await this.#store.find(jobId);
			if (existing === null) return { jobId, outcome: 'stale' };
			if (existing.status === 'succeeded') {
				return { jobId, outcome: 'succeeded', job: existing };
			}
			if (existing.status === 'failed' && !existing.retryable) {
				const errorCode: string = existing.lastError ?? 'permanently_failed';
				return {
					jobId,
					outcome:
						errorCode === 'docx_integrity_failed' ? 'integrity_failed' : 'permanently_failed',
					errorCode
				};
			}
			return { jobId, outcome: 'stale' };
		}

		return await this.#executeClaimedJob(claimed[0]);
	}

	async processInline(jobId: string, options?: { now?: Date }): Promise<DocxConversionItemOutcome> {
		return await this.processJob(jobId, options);
	}

	async readExportResult(job: DocxExportJob): Promise<Uint8Array> {
		if (job.status !== 'succeeded' || job.result === null) {
			throw new DocxExportError('result_not_ready', 'The DOCX export result is not ready');
		}
		const stream: ReadableStream<Uint8Array> | null = await this.#objects.get(job.result.objectKey);
		if (stream === null) {
			throw new DraftIntegrityError('Published DOCX export object is missing');
		}
		const bytes: Uint8Array = await readStreamBounded(stream, job.result.byteSize);
		if (
			bytes.byteLength !== job.result.byteSize ||
			(await sha256Hex(bytes)) !== job.result.sha256
		) {
			throw new DraftIntegrityError('Published DOCX export object failed verification');
		}
		return bytes;
	}

	async processPendingBatch(options?: {
		limit?: number;
		now?: Date;
	}): Promise<DocxConversionBatchResult> {
		const now: Date = options?.now ?? (this.#now ? this.#now() : new Date());
		const claimToken: string = newOpaqueToken();
		const claimedAt: string = now.toISOString();
		const staleBefore: string = new Date(now.valueOf() - this.#leaseMs).toISOString();
		const limit: number = boundDocxConversionClaimLimit(
			options?.limit ?? MAX_DOCX_CONVERSION_CLAIM_BATCH
		);

		const claimed: readonly ClaimedDocxConversionJob[] = await this.#store.claim({
			claimToken,
			claimedAt,
			staleBefore,
			limit
		});

		const items: DocxConversionItemOutcome[] = [];
		for (const item of claimed) {
			items.push(await this.#executeClaimedJob(item));
		}

		return {
			claimed: claimed.length,
			succeeded: items.filter((i): boolean => i.outcome === 'succeeded').length,
			failed: items.filter(
				(i): boolean =>
					i.outcome === 'retryable_failed' ||
					i.outcome === 'permanently_failed' ||
					i.outcome === 'integrity_failed'
			).length,
			stale: items.filter((i): boolean => i.outcome === 'stale').length,
			items
		};
	}

	async processBatch(options?: { limit?: number; now?: Date }): Promise<DocxConversionBatchResult> {
		return await this.processPendingBatch(options);
	}

	async #executeClaimedJob(claim: ClaimedDocxConversionJob): Promise<DocxConversionItemOutcome> {
		if (claim.job.direction === 'import') {
			return await this.#executeImport(claim);
		}
		return await this.#executeExport(claim);
	}

	async #executeImport(claim: ClaimedDocxConversionJob): Promise<DocxConversionItemOutcome> {
		if (claim.job.direction !== 'import') {
			throw new Error('Expected import job');
		}

		try {
			const stream = await this.#objects.get(claim.job.sourceObjectKey);
			if (stream === null) {
				throw new DraftIntegrityError('Source DOCX object not found in ObjectStore');
			}
			const bytes: Uint8Array = await readStreamBounded(stream, claim.job.sourceByteSize);
			if (bytes.byteLength !== claim.job.sourceByteSize) {
				throw new DraftIntegrityError('Source DOCX byte size mismatch');
			}
			const actualSha: string = await sha256Hex(bytes);
			if (actualSha !== claim.job.sourceSha256) {
				throw new DraftIntegrityError('Source DOCX digest mismatch');
			}

			const commitResult = await this.#importService.importAndCommit({
				envelopeId: claim.job.envelopeId,
				targetPath: claim.job.targetPath,
				expectedGeneration: claim.job.expectedGeneration,
				actor: claim.job.actor,
				idempotencyKey: claim.job.idempotencyKey,
				docxBytes: bytes,
				limits: this.#importLimits
			});

			const completedAt: string = (this.#now ? this.#now() : new Date()).toISOString();
			let completed: boolean;
			try {
				completed = await this.#store.completeImport({
					jobId: claim.job.id,
					claimToken: claim.claimToken,
					attemptId: this.#newId(),
					attemptNumber: claim.job.attempts,
					startedAt: claim.startedAt,
					completedAt,
					resultGeneration: commitResult.revision.generation,
					resultCommitSha: commitResult.revision.commitSha,
					resultArchiveSha256: commitResult.revision.archiveSha256
				});
			} catch {
				return {
					jobId: claim.job.id,
					outcome: 'retryable_failed',
					errorCode: 'job_completion_unknown'
				};
			}

			if (!completed) return { jobId: claim.job.id, outcome: 'stale' };

			const updated: DocxConversionJob | null = await this.#store.find(claim.job.id);
			return { jobId: claim.job.id, outcome: 'succeeded', job: updated ?? claim.job };
		} catch (error: unknown) {
			return await this.#failJob(claim, error);
		}
	}

	async #executeExport(claim: ClaimedDocxConversionJob): Promise<DocxConversionItemOutcome> {
		if (claim.job.direction !== 'export') {
			throw new Error('Expected export job');
		}

		try {
			const exported = await exportPinnedDocx(
				{
					envelopeId: claim.job.envelopeId,
					commitSha: claim.job.sourceCommitSha,
					archiveKey: claim.job.sourceArchiveKey,
					archiveSha256: claim.job.sourceArchiveSha256
				},
				this.#objects,
				this.#draftRepository
			);

			const resultSha256: string = await sha256Hex(exported.bytes);
			const resultObjectKey: string = docxExportResultObjectKey(claim.job.envelopeId, resultSha256);
			await this.#persistImmutableDocx(resultObjectKey, exported.bytes, resultSha256);

			const completedAt: string = (this.#now ? this.#now() : new Date()).toISOString();
			let completed: boolean;
			try {
				completed = await this.#store.completeExport({
					jobId: claim.job.id,
					claimToken: claim.claimToken,
					attemptId: this.#newId(),
					attemptNumber: claim.job.attempts,
					startedAt: claim.startedAt,
					completedAt,
					resultObjectKey,
					resultSha256,
					resultByteSize: exported.bytes.byteLength,
					resultSkippedPdfCount: exported.skippedPdfCount
				});
			} catch {
				return {
					jobId: claim.job.id,
					outcome: 'retryable_failed',
					errorCode: 'job_completion_unknown'
				};
			}

			if (!completed) return { jobId: claim.job.id, outcome: 'stale' };

			const updated: DocxConversionJob | null = await this.#store.find(claim.job.id);
			return { jobId: claim.job.id, outcome: 'succeeded', job: updated ?? claim.job };
		} catch (error: unknown) {
			return await this.#failJob(claim, error);
		}
	}

	async #failJob(
		claim: ClaimedDocxConversionJob,
		error: unknown
	): Promise<DocxConversionItemOutcome> {
		const { outcome, retryable, errorCode } = this.#classifyFailure(claim.job.attempts, error);

		const failureNow: Date = this.#now ? this.#now() : new Date();
		const failedAt: string = failureNow.toISOString();
		const nextAvailableAt: string = retryable
			? docxConversionRetryAvailableAt(
					failureNow,
					claim.job.attempts,
					this.#baseDelayMs,
					this.#maxDelayMs
				)
			: failedAt;

		const failed: boolean = await this.#store.fail({
			jobId: claim.job.id,
			claimToken: claim.claimToken,
			attemptId: this.#newId(),
			attemptNumber: claim.job.attempts,
			startedAt: claim.startedAt,
			failedAt,
			errorCode,
			retryable,
			nextAvailableAt
		});

		if (!failed) return { jobId: claim.job.id, outcome: 'stale' };
		return { jobId: claim.job.id, outcome, errorCode };
	}

	#classifyFailure(
		attempts: number,
		error: unknown
	): {
		outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed';
		retryable: boolean;
		errorCode: string;
	} {
		if (error instanceof DraftIntegrityError) {
			return {
				outcome: 'integrity_failed',
				retryable: false,
				errorCode: 'docx_integrity_failed'
			};
		}

		if (
			error instanceof DocxImportError ||
			error instanceof DocxExportError ||
			error instanceof DocumentSetError
		) {
			const rawCode: string =
				error instanceof Error && 'code' in error && typeof error.code === 'string'
					? error.code
					: 'validation_failed';
			return {
				outcome: 'permanently_failed',
				retryable: false,
				errorCode: sanitizeDocxConversionErrorCode(rawCode.toLowerCase())
			};
		}

		if (error instanceof DraftIdempotencyConflictError) {
			return {
				outcome: 'permanently_failed',
				retryable: false,
				errorCode: 'idempotency_conflict'
			};
		}

		if (
			error instanceof DraftGenerationConflictError ||
			error instanceof DraftEnvelopeImmutableError ||
			error instanceof DraftEnvelopeNotFoundError
		) {
			return {
				outcome: 'permanently_failed',
				retryable: false,
				errorCode: 'concurrency_conflict'
			};
		}

		if (attempts >= this.#maxAttempts) {
			return {
				outcome: 'permanently_failed',
				retryable: false,
				errorCode: 'attempts_exhausted'
			};
		}

		const rawCode: string =
			error instanceof Error && 'code' in error && typeof error.code === 'string'
				? error.code
				: 'conversion_transient_failure';

		return {
			outcome: 'retryable_failed',
			retryable: true,
			errorCode: sanitizeDocxConversionErrorCode(rawCode.toLowerCase())
		};
	}

	async #persistImmutableDocx(key: string, bytes: Uint8Array, sha256: string): Promise<void> {
		try {
			const stored = await this.#objects.putImmutable(key, {
				contentType: DOCX_MIME_TYPE,
				body: bytes,
				sha256,
				metadata: { format: 'signkit-docx-conversion-v1' }
			});
			if (stored.key !== key || stored.sha256 !== sha256 || stored.size !== bytes.byteLength) {
				throw new DraftIntegrityError('ObjectStore did not confirm stored DOCX bytes');
			}
		} catch (error: unknown) {
			if (error instanceof DraftIntegrityError) throw error;
			const existing = await this.#objects.head(key);
			if (existing === null || existing.sha256 !== sha256 || existing.size !== bytes.byteLength) {
				throw error;
			}
			const stream = await this.#objects.get(key);
			if (stream === null) throw error;
			const retrieved = await readStreamBounded(stream, bytes.byteLength);
			if (retrieved.byteLength !== bytes.byteLength || (await sha256Hex(retrieved)) !== sha256) {
				throw error;
			}
		}
	}
}
