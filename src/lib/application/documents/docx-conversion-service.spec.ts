import { describe, expect, it, vi } from 'vitest';
import {
	DocxConversionService,
	docxConversionRetryAvailableAt,
	docxImportSourceObjectKey,
	sha256Hex,
	type EnqueueDocxImportInput,
	type EnqueueDocxExportInput
} from './docx-conversion-service';
import type {
	ClaimDocxConversionsCommand,
	ClaimedDocxConversionJob,
	CompleteDocxExportCommand,
	CompleteDocxImportCommand,
	DocxConversionJob,
	DocxConversionStore,
	DocxExportJob,
	DocxImportJob,
	EnqueueDocxExportCommand,
	EnqueueDocxImportCommand,
	FailDocxConversionCommand
} from '$lib/ports/docx-conversion-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { Envelope } from '$lib/domain/envelope';
import {
	DraftGenerationConflictError,
	draftArchiveKey
} from '$lib/application/drafts/draft-persistence';
import { DocxImportError } from '$lib/adapters/documents/docx-import';

const ENVELOPE_ID = '01900000-0000-7000-8000-000000000001';
const USER_ID = 'user-test-1';
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_SHA = 'a'.repeat(64);
const ARCHIVE_KEY = draftArchiveKey(ENVELOPE_ID, ARCHIVE_SHA);
const NOW = new Date('2026-09-12T12:00:00.000Z');

class FakeDocxConversionStore implements DocxConversionStore {
	jobs = new Map<string, DocxConversionJob>();
	enqueueImportCommands: EnqueueDocxImportCommand[] = [];
	enqueueExportCommands: EnqueueDocxExportCommand[] = [];
	claimCommands: ClaimDocxConversionsCommand[] = [];
	completeImportCommands: CompleteDocxImportCommand[] = [];
	completeExportCommands: CompleteDocxExportCommand[] = [];
	failCommands: FailDocxConversionCommand[] = [];

	async enqueueImport(command: EnqueueDocxImportCommand) {
		this.enqueueImportCommands.push(command);
		const job: DocxImportJob = {
			id: command.id,
			envelopeId: command.envelopeId,
			direction: 'import',
			requestKey: command.requestKey,
			requestFingerprint: command.requestFingerprint,
			status: 'pending',
			attempts: 0,
			availableAt: command.createdAt,
			retryable: true,
			lastError: null,
			createdAt: command.createdAt,
			updatedAt: command.createdAt,
			sourceObjectKey: command.sourceObjectKey,
			sourceSha256: command.sourceSha256,
			sourceByteSize: command.sourceByteSize,
			targetPath: command.targetPath,
			expectedGeneration: command.expectedGeneration,
			actor: command.actor,
			idempotencyKey: command.idempotencyKey,
			result: null
		};
		this.jobs.set(command.id, job);
		return { outcome: 'enqueued' as const, job };
	}

	async enqueueExport(command: EnqueueDocxExportCommand) {
		this.enqueueExportCommands.push(command);
		const job: DocxExportJob = {
			id: command.id,
			envelopeId: command.envelopeId,
			direction: 'export',
			requestKey: command.requestKey,
			requestFingerprint: command.requestFingerprint,
			status: 'pending',
			attempts: 0,
			availableAt: command.createdAt,
			retryable: true,
			lastError: null,
			createdAt: command.createdAt,
			updatedAt: command.createdAt,
			sourceCommitSha: command.sourceCommitSha,
			sourceArchiveKey: command.sourceArchiveKey,
			sourceArchiveSha256: command.sourceArchiveSha256,
			result: null
		};
		this.jobs.set(command.id, job);
		return { outcome: 'enqueued' as const, job };
	}

	async claim(command: ClaimDocxConversionsCommand): Promise<readonly ClaimedDocxConversionJob[]> {
		this.claimCommands.push(command);
		const claimed: ClaimedDocxConversionJob[] = [];
		for (const job of this.jobs.values()) {
			if (command.jobId && job.id !== command.jobId) continue;
			if (job.status === 'pending' || (job.status === 'failed' && job.retryable)) {
				const updated = {
					...job,
					status: 'processing' as const,
					attempts: job.attempts + 1,
					updatedAt: command.claimedAt,
					lockedAt: command.claimedAt
				};
				this.jobs.set(job.id, updated);
				claimed.push({
					job: updated,
					claimToken: command.claimToken,
					startedAt: command.claimedAt
				});
				if (claimed.length >= command.limit) break;
			}
		}
		return claimed;
	}

	async completeImport(command: CompleteDocxImportCommand): Promise<boolean> {
		this.completeImportCommands.push(command);
		const job = this.jobs.get(command.jobId);
		if (!job || job.direction !== 'import') return false;
		this.jobs.set(command.jobId, {
			...job,
			status: 'succeeded',
			retryable: false,
			completedAt: command.completedAt,
			updatedAt: command.completedAt,
			result: {
				generation: command.resultGeneration,
				commitSha: command.resultCommitSha,
				archiveSha256: command.resultArchiveSha256
			}
		});
		return true;
	}

	async completeExport(command: CompleteDocxExportCommand): Promise<boolean> {
		this.completeExportCommands.push(command);
		const job = this.jobs.get(command.jobId);
		if (!job || job.direction !== 'export') return false;
		this.jobs.set(command.jobId, {
			...job,
			status: 'succeeded',
			retryable: false,
			completedAt: command.completedAt,
			updatedAt: command.completedAt,
			result: {
				objectKey: command.resultObjectKey,
				sha256: command.resultSha256,
				byteSize: command.resultByteSize,
				skippedPdfCount: command.resultSkippedPdfCount
			}
		});
		return true;
	}

	async fail(command: FailDocxConversionCommand): Promise<boolean> {
		this.failCommands.push(command);
		const job = this.jobs.get(command.jobId);
		if (!job) return false;
		this.jobs.set(command.jobId, {
			...job,
			status: 'failed',
			retryable: command.retryable,
			lastError: command.errorCode,
			availableAt: command.nextAvailableAt,
			updatedAt: command.failedAt
		});
		return true;
	}

	async find(jobId: string): Promise<DocxConversionJob | null> {
		return this.jobs.get(jobId) ?? null;
	}
}

class FixedDraftRepository implements DraftRepository {
	constructor(private readonly documents: readonly DraftDocument[] = []) {}

	async read(): Promise<readonly DraftDocument[]> {
		return this.documents;
	}

	async readManifest(): Promise<string | null> {
		return null;
	}

	async commit(): Promise<DraftVersion> {
		throw new Error('commit not implemented in fake');
	}
}

describe('DocxConversionService', () => {
	it('enqueues an import job and verifies/persists bytes in ObjectStore', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const importService = { importAndCommit: vi.fn() };
		const draftRepository = new FixedDraftRepository();

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW,
			newId: () => 'job-import-1'
		});

		const rawDocxBytes = new TextEncoder().encode('fake-docx-binary-content');
		const expectedSha = await sha256Hex(rawDocxBytes);
		const expectedObjectKey = docxImportSourceObjectKey(ENVELOPE_ID, expectedSha);

		const input: EnqueueDocxImportInput = {
			envelopeId: ENVELOPE_ID,
			bytes: rawDocxBytes,
			targetPath: 'documents/agreement.md',
			expectedGeneration: 0,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-key-1'
		};

		const result = await service.enqueueImport(input);
		expect(result.outcome).toBe('enqueued');
		if (result.outcome !== 'enqueued') return;
		expect(result.job.id).toBe('job-import-1');

		// Object must be stored in ObjectStore
		const head = await objects.head(expectedObjectKey);
		expect(head).not.toBeNull();
		expect(head?.sha256).toBe(expectedSha);
		expect(head?.size).toBe(rawDocxBytes.byteLength);

		// Store must receive command with sourceObjectKey and sourceSha256
		expect(store.enqueueImportCommands).toHaveLength(1);
		expect(store.enqueueImportCommands[0].sourceObjectKey).toBe(expectedObjectKey);
		expect(store.enqueueImportCommands[0].sourceSha256).toBe(expectedSha);
		expect(store.enqueueImportCommands[0].sourceByteSize).toBe(rawDocxBytes.byteLength);
	});

	it('enqueues an export job resolving commit and archive from envelopes store if omitted', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const importService = { importAndCommit: vi.fn() };
		const draftRepository = new FixedDraftRepository();
		const envelopes: Pick<EnvelopeStore, 'findEnvelope'> = {
			findEnvelope: vi.fn(
				async (): Promise<Envelope | null> =>
					({
						id: ENVELOPE_ID,
						title: 'Agreement',
						status: 'sent',
						sentCommitSha: COMMIT_SHA,
						repositoryHead: 'head-sha',
						repositoryArchiveKey: ARCHIVE_KEY,
						repositoryArchiveSha256: ARCHIVE_SHA
					}) as unknown as Envelope
			)
		};

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			envelopes,
			now: () => NOW,
			newId: () => 'job-export-1'
		});

		const input: EnqueueDocxExportInput = {
			envelopeId: ENVELOPE_ID
		};

		const result = await service.enqueueExport(input);
		expect(result.outcome).toBe('enqueued');
		expect(envelopes.findEnvelope).toHaveBeenCalledWith(ENVELOPE_ID);
		expect(store.enqueueExportCommands).toHaveLength(1);
		expect(store.enqueueExportCommands[0].sourceCommitSha).toBe(COMMIT_SHA);
		expect(store.enqueueExportCommands[0].sourceArchiveKey).toBe(ARCHIVE_KEY);
		expect(store.enqueueExportCommands[0].sourceArchiveSha256).toBe(ARCHIVE_SHA);
	});

	it('processes an import job inline: verifies source bytes, converts, and completes', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const draftRepository = new FixedDraftRepository();

		const rawDocxBytes = new TextEncoder().encode('valid-docx-content');

		const importService = {
			importAndCommit: vi.fn(async () => ({
				outcome: 'committed' as const,
				revision: {
					generation: 1,
					commitSha: 'commit-imported-1',
					archiveKey: 'archives/archive-1.git.gz',
					archiveSha256: 'sha-archive-1',
					updatedAt: NOW.toISOString(),
					auditEventId: 'audit-event-1'
				}
			}))
		};

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW,
			newId: () => 'attempt-uuid-1'
		});

		// Enqueue the job first
		await service.enqueueImport({
			envelopeId: ENVELOPE_ID,
			bytes: rawDocxBytes,
			targetPath: 'documents/agreement.md',
			expectedGeneration: 0,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-1'
		});
		const enqueuedJobId = store.enqueueImportCommands[0].id;

		// Process job inline
		const outcome = await service.processJob(enqueuedJobId);
		expect(outcome.outcome).toBe('succeeded');
		expect(importService.importAndCommit).toHaveBeenCalledWith(
			expect.objectContaining({
				envelopeId: ENVELOPE_ID,
				targetPath: 'documents/agreement.md',
				expectedGeneration: 0,
				actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
				idempotencyKey: 'idem-1',
				docxBytes: rawDocxBytes
			})
		);

		expect(store.completeImportCommands).toHaveLength(1);
		expect(store.completeImportCommands[0].resultGeneration).toBe(1);
		expect(store.completeImportCommands[0].resultCommitSha).toBe('commit-imported-1');
		expect(store.completeImportCommands[0].resultArchiveSha256).toBe('sha-archive-1');

		const finishedJob = await store.find(enqueuedJobId);
		expect(finishedJob?.status).toBe('succeeded');
	});

	it('processes an export job inline: renders pinned docx, stores content-addressed, and completes', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const importService = { importAndCommit: vi.fn() };

		// Seed archive
		const archiveBytes = new TextEncoder().encode('fake-archive-bytes');
		const archiveSha = await sha256Hex(archiveBytes);
		const archiveKey = draftArchiveKey(ENVELOPE_ID, archiveSha);
		objects.seed(archiveKey, archiveBytes, archiveSha);

		const draftRepository = new FixedDraftRepository([
			{ path: 'documents/agreement.md', content: '# Agreement Title\n\nContent here.\n' }
		]);

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW,
			newId: () => 'attempt-export-1'
		});

		await service.enqueueExport({
			envelopeId: ENVELOPE_ID,
			sourceCommitSha: COMMIT_SHA,
			sourceArchiveKey: archiveKey,
			sourceArchiveSha256: archiveSha
		});
		const enqueuedJobId = store.enqueueExportCommands[0].id;

		const outcome = await service.processJob(enqueuedJobId);
		expect(outcome.outcome).toBe('succeeded');
		expect(store.completeExportCommands).toHaveLength(1);
		const completeCmd = store.completeExportCommands[0];
		expect(completeCmd.resultObjectKey).toContain('docx-conversions/v1/envelopes');
		expect(completeCmd.resultSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(completeCmd.resultByteSize).toBeGreaterThan(0);

		// Object must be in ObjectStore
		const storedDocx = await objects.head(completeCmd.resultObjectKey);
		expect(storedDocx).not.toBeNull();
		expect(storedDocx?.sha256).toBe(completeCmd.resultSha256);
	});

	it('fails with integrity error and non-retryable status when downloaded source bytes SHA256 mismatches', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const importService = { importAndCommit: vi.fn() };
		const draftRepository = new FixedDraftRepository();

		// Seed corrupted bytes with wrong hash
		const tamperedBytes = new TextEncoder().encode('tampered-bytes');
		const sourceKey = docxImportSourceObjectKey(ENVELOPE_ID, 'b'.repeat(64));
		objects.seed(sourceKey, tamperedBytes);

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW
		});

		// Directly inject a job with pinned sha 'b'.repeat(64)
		const job: DocxImportJob = {
			id: 'job-tampered',
			envelopeId: ENVELOPE_ID,
			direction: 'import',
			requestKey: 'req-tampered',
			requestFingerprint: 'fp-tampered',
			status: 'pending',
			attempts: 0,
			availableAt: NOW.toISOString(),
			retryable: true,
			lastError: null,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
			sourceObjectKey: sourceKey,
			sourceSha256: 'b'.repeat(64),
			sourceByteSize: tamperedBytes.byteLength,
			targetPath: 'documents/agreement.md',
			expectedGeneration: 0,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-tampered',
			result: null
		};
		store.jobs.set(job.id, job);

		const outcome = await service.processJob(job.id);
		expect(outcome.outcome).toBe('integrity_failed');
		expect(store.failCommands).toHaveLength(1);
		expect(store.failCommands[0].retryable).toBe(false);
		expect(store.failCommands[0].errorCode).toBe('docx_integrity_failed');
	});

	it('fails with validation error and non-retryable status when DocxImportError is thrown', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const rawDocxBytes = new TextEncoder().encode('corrupt-zip-file');

		const importService = {
			importAndCommit: vi.fn(async () => {
				throw new DocxImportError('DOCX_IMPORT_CORRUPT', 'File is not a valid zip archive');
			})
		};
		const draftRepository = new FixedDraftRepository();

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW
		});

		await service.enqueueImport({
			envelopeId: ENVELOPE_ID,
			bytes: rawDocxBytes,
			targetPath: 'documents/agreement.md',
			expectedGeneration: 0,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-1'
		});
		const jobId = store.enqueueImportCommands[0].id;

		const outcome = await service.processJob(jobId);
		expect(outcome.outcome).toBe('permanently_failed');
		expect(store.failCommands).toHaveLength(1);
		expect(store.failCommands[0].retryable).toBe(false);
		expect(store.failCommands[0].errorCode).toBe('docx_import_corrupt');
	});

	it('fails with concurrency conflict and non-retryable status when DraftGenerationConflictError is thrown', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const rawDocxBytes = new TextEncoder().encode('docx-content');

		const importService = {
			importAndCommit: vi.fn(async () => {
				throw new DraftGenerationConflictError(1);
			})
		};
		const draftRepository = new FixedDraftRepository();

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW
		});

		await service.enqueueImport({
			envelopeId: ENVELOPE_ID,
			bytes: rawDocxBytes,
			targetPath: 'documents/agreement.md',
			expectedGeneration: 1,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-1'
		});
		const jobId = store.enqueueImportCommands[0].id;

		const outcome = await service.processJob(jobId);
		expect(outcome.outcome).toBe('permanently_failed');
		expect(store.failCommands).toHaveLength(1);
		expect(store.failCommands[0].retryable).toBe(false);
		expect(store.failCommands[0].errorCode).toBe('concurrency_conflict');
	});

	it('applies exponential backoff on transient failure, and permanently fails when max attempts reached', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const rawDocxBytes = new TextEncoder().encode('docx-content');

		const importService = {
			importAndCommit: vi.fn(async () => {
				throw new Error('transient network glitch');
			})
		};
		const draftRepository = new FixedDraftRepository();

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW,
			maxAttempts: 3,
			baseDelayMs: 30_000
		});

		await service.enqueueImport({
			envelopeId: ENVELOPE_ID,
			bytes: rawDocxBytes,
			targetPath: 'documents/agreement.md',
			expectedGeneration: 0,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-1'
		});
		const jobId = store.enqueueImportCommands[0].id;

		// Attempt 1 fails (transient, retryable)
		const outcome1 = await service.processJob(jobId);
		expect(outcome1.outcome).toBe('retryable_failed');
		expect(store.failCommands[0].retryable).toBe(true);
		// Backoff for attempt 1: 30s
		expect(store.failCommands[0].nextAvailableAt).toBe(
			docxConversionRetryAvailableAt(NOW, 1, 30_000)
		);

		// Attempt 2 fails (transient, retryable)
		const outcome2 = await service.processJob(jobId);
		expect(outcome2.outcome).toBe('retryable_failed');
		expect(store.failCommands[1].retryable).toBe(true);
		// Backoff for attempt 2: 60s
		expect(store.failCommands[1].nextAvailableAt).toBe(
			docxConversionRetryAvailableAt(NOW, 2, 30_000)
		);

		// Attempt 3 fails (max attempts reached, permanently_failed)
		const outcome3 = await service.processJob(jobId);
		expect(outcome3.outcome).toBe('permanently_failed');
		expect(store.failCommands[2].retryable).toBe(false);
		expect(store.failCommands[2].errorCode).toBe('attempts_exhausted');
	});

	it('processes a batch of pending conversions and aggregates statistics', async () => {
		const store = new FakeDocxConversionStore();
		const objects = new InMemoryObjectStore();
		const draftRepository = new FixedDraftRepository();

		const rawDocxBytes = new TextEncoder().encode('valid-docx-content');

		const importService = {
			importAndCommit: vi.fn(async () => ({
				outcome: 'committed' as const,
				revision: {
					generation: 1,
					commitSha: 'commit-1',
					archiveKey: 'archives/1.git.gz',
					archiveSha256: 'sha-1',
					updatedAt: NOW.toISOString(),
					auditEventId: 'audit-event-1'
				}
			}))
		};

		const service = new DocxConversionService({
			store,
			objects,
			importService,
			draftRepository,
			now: () => NOW
		});

		await service.enqueueImport({
			envelopeId: ENVELOPE_ID,
			bytes: rawDocxBytes,
			targetPath: 'documents/doc1.md',
			expectedGeneration: 0,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-1'
		});
		await service.enqueueImport({
			envelopeId: ENVELOPE_ID,
			bytes: rawDocxBytes,
			targetPath: 'documents/doc2.md',
			expectedGeneration: 0,
			actor: { id: USER_ID, name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'idem-2'
		});

		const batchResult = await service.processPendingBatch({ limit: 10 });
		expect(batchResult.claimed).toBe(2);
		expect(batchResult.succeeded).toBe(2);
		expect(batchResult.failed).toBe(0);
		expect(batchResult.stale).toBe(0);
		expect(batchResult.items).toHaveLength(2);
	});
});
