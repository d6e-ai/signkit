import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1DocxConversionStore } from './d1-docx-conversion-store';
import { sqliteD1Database } from './sqlite-d1-test-support';
import type {
	ClaimedDocxConversionJob,
	DocxImportJob,
	DocxExportJob,
	EnqueueDocxImportCommand,
	EnqueueDocxExportCommand
} from '$lib/ports/docx-conversion-store';

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/d1')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/d1/${name}`);

const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000021';
const USER_ID: string = 'user-docx-tester';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_KEY: string = 'archives/integration.git.gz';
const ARCHIVE_SHA: string = 'a'.repeat(64);

function fixture(): { store: D1DocxConversionStore; sqlite: DatabaseSync } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATION_PATHS) {
		sqlite.exec(readFileSync(path, 'utf8'));
	}
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${USER_ID}','owner','active','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}','${USER_ID}','Agreement','draft',1,'${COMMIT_SHA}',
			'${ARCHIVE_KEY}','${ARCHIVE_SHA}',
			'2026-09-11T00:00:00.000Z','2026-09-11T00:02:00.000Z'
		);
	`);
	return { store: new D1DocxConversionStore(sqliteD1Database(sqlite)), sqlite };
}

const importCmd: EnqueueDocxImportCommand = {
	id: '01950000-0000-7000-8000-000000000001',
	envelopeId: ENVELOPE_ID,
	requestKey: 'import-key-1',
	requestFingerprint: 'fingerprint-1',
	sourceObjectKey: 'docx-imports/v1/source.docx',
	sourceSha256: 'b'.repeat(64),
	sourceByteSize: 1024,
	targetPath: 'documents/agreement.md',
	expectedGeneration: 1,
	actor: {
		id: USER_ID,
		name: 'Docx Tester',
		email: 'tester@example.com',
		type: 'user'
	},
	idempotencyKey: 'idem-1',
	createdAt: '2026-09-12T00:00:00.000Z'
};

const exportCmd: EnqueueDocxExportCommand = {
	id: '01950000-0000-7000-8000-000000000002',
	envelopeId: ENVELOPE_ID,
	requestKey: 'export-key-1',
	requestFingerprint: 'export-fingerprint-1',
	sourceCommitSha: COMMIT_SHA,
	sourceArchiveKey: ARCHIVE_KEY,
	sourceArchiveSha256: ARCHIVE_SHA,
	createdAt: '2026-09-12T00:00:00.000Z'
};

describe('D1DocxConversionStore (Integration with real SQLite & migrations)', () => {
	it('enqueues an import job and detects idempotency and conflicts', async () => {
		const { store } = fixture();

		// Enqueue
		const result1 = await store.enqueueImport(importCmd);
		expect(result1.outcome).toBe('enqueued');
		if (result1.outcome !== 'enqueued') return;
		expect(result1.job.id).toBe(importCmd.id);
		expect(result1.job.direction).toBe('import');
		expect(result1.job.status).toBe('pending');
		expect(result1.job.attempts).toBe(0);
		expect((result1.job as DocxImportJob).targetPath).toBe('documents/agreement.md');

		// Idempotent re-enqueue with same fingerprint
		const result2 = await store.enqueueImport(importCmd);
		expect(result2.outcome).toBe('existing');
		if (result2.outcome !== 'existing') return;
		expect(result2.job.id).toBe(importCmd.id);

		// Conflict with different fingerprint
		const result3 = await store.enqueueImport({
			...importCmd,
			requestFingerprint: 'different-fingerprint'
		});
		expect(result3.outcome).toBe('conflict');
	});

	it('enqueues an export job and detects idempotency and conflicts', async () => {
		const { store } = fixture();

		// Enqueue export
		const result1 = await store.enqueueExport(exportCmd);
		expect(result1.outcome).toBe('enqueued');
		if (result1.outcome !== 'enqueued') return;
		expect(result1.job.id).toBe(exportCmd.id);
		expect(result1.job.direction).toBe('export');
		expect((result1.job as DocxExportJob).sourceCommitSha).toBe(COMMIT_SHA);

		// Idempotent
		const result2 = await store.enqueueExport(exportCmd);
		expect(result2.outcome).toBe('existing');

		// Conflict
		const result3 = await store.enqueueExport({
			...exportCmd,
			requestFingerprint: 'different-fingerprint'
		});
		expect(result3.outcome).toBe('conflict');
	});

	it('claims pending jobs, respects lease locking, and reclaims stale leases', async () => {
		const { store } = fixture();
		await store.enqueueImport(importCmd);

		// Claim 1
		const claimed1: readonly ClaimedDocxConversionJob[] = await store.claim({
			claimToken: 'token-1',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 5
		});
		expect(claimed1).toHaveLength(1);
		expect(claimed1[0].job.id).toBe(importCmd.id);
		expect(claimed1[0].claimToken).toBe('token-1');
		expect(claimed1[0].job.attempts).toBe(1);
		expect(claimed1[0].job.status).toBe('processing');

		// Concurrent claim should find nothing because lease is active
		const claimed2: readonly ClaimedDocxConversionJob[] = await store.claim({
			claimToken: 'token-2',
			claimedAt: '2026-09-12T00:02:00.000Z',
			staleBefore: '2026-09-12T00:00:00.000Z', // token-1 was locked at 00:01:00, which is >= 00:00:00
			limit: 5
		});
		expect(claimed2).toHaveLength(0);

		// Reclaim stale lease: staleBefore is 00:06:00, which is > lockedAt 00:01:00
		const reclaimed: readonly ClaimedDocxConversionJob[] = await store.claim({
			claimToken: 'token-3',
			claimedAt: '2026-09-12T00:07:00.000Z',
			staleBefore: '2026-09-12T00:06:00.000Z',
			limit: 5
		});
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0].claimToken).toBe('token-3');
		expect(reclaimed[0].job.attempts).toBe(2);
	});

	it('claims a specific job by jobId', async () => {
		const { store } = fixture();
		await store.enqueueImport(importCmd);
		await store.enqueueExport(exportCmd);

		const claimed = await store.claim({
			claimToken: 'token-export',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 5,
			jobId: exportCmd.id
		});
		expect(claimed).toHaveLength(1);
		expect(claimed[0].job.id).toBe(exportCmd.id);
		expect(claimed[0].job.direction).toBe('export');
	});

	it('completes an import atomically and records an immutable attempt', async () => {
		const { store, sqlite } = fixture();
		await store.enqueueImport(importCmd);

		const claimed = await store.claim({
			claimToken: 'token-import',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 1
		});
		expect(claimed).toHaveLength(1);

		// Stale complete attempt returns false
		const staleOk = await store.completeImport({
			jobId: importCmd.id,
			claimToken: 'wrong-token',
			attemptId: '01950000-0000-7000-8000-000000000010',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			completedAt: '2026-09-12T00:01:05.000Z',
			resultGeneration: 2,
			resultCommitSha: 'commit-2',
			resultArchiveSha256: 'archive-2'
		});
		expect(staleOk).toBe(false);

		// Verify no attempt was inserted
		const attemptCountBefore = sqlite
			.prepare(`SELECT count(*) as c FROM docx_conversion_attempt`)
			.get() as { c: number };
		expect(attemptCountBefore.c).toBe(0);

		// Valid complete
		const ok = await store.completeImport({
			jobId: importCmd.id,
			claimToken: 'token-import',
			attemptId: '01950000-0000-7000-8000-000000000010',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			completedAt: '2026-09-12T00:01:05.000Z',
			resultGeneration: 2,
			resultCommitSha: 'commit-2',
			resultArchiveSha256: 'archive-2'
		});
		expect(ok).toBe(true);

		// Verify job state
		const job = (await store.find(importCmd.id)) as DocxImportJob;
		expect(job.status).toBe('succeeded');
		expect(job.retryable).toBe(false);
		expect(job.result).toEqual({
			generation: 2,
			commitSha: 'commit-2',
			archiveSha256: 'archive-2'
		});

		// Verify attempt record
		const attempt = sqlite
			.prepare(`SELECT * FROM docx_conversion_attempt WHERE id = ?`)
			.get('01950000-0000-7000-8000-000000000010') as {
			outcome: string;
			source_sha256: string;
			result_sha256: string;
		};
		expect(attempt.outcome).toBe('succeeded');
		expect(attempt.source_sha256).toBe(importCmd.sourceSha256);
		expect(attempt.result_sha256).toBe('archive-2');

		// Verify attempt immutability triggers: UPDATE and DELETE must abort
		expect(() =>
			sqlite
				.prepare(`UPDATE docx_conversion_attempt SET outcome = 'failed' WHERE id = ?`)
				.run('01950000-0000-7000-8000-000000000010')
		).toThrow(/docx conversion attempts are immutable/);

		expect(() =>
			sqlite
				.prepare(`DELETE FROM docx_conversion_attempt WHERE id = ?`)
				.run('01950000-0000-7000-8000-000000000010')
		).toThrow(/docx conversion attempts are immutable/);
	});

	it('completes an export atomically and records an immutable attempt', async () => {
		const { store, sqlite } = fixture();
		await store.enqueueExport(exportCmd);

		const claimed = await store.claim({
			claimToken: 'token-export',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 1
		});
		expect(claimed).toHaveLength(1);

		const ok = await store.completeExport({
			jobId: exportCmd.id,
			claimToken: 'token-export',
			attemptId: '01950000-0000-7000-8000-000000000020',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			completedAt: '2026-09-12T00:01:10.000Z',
			resultObjectKey: 'docx-exports/v1/export.docx',
			resultSha256: 'c'.repeat(64),
			resultByteSize: 2048,
			resultSkippedPdfCount: 1
		});
		expect(ok).toBe(true);

		const job = (await store.find(exportCmd.id)) as DocxExportJob;
		expect(job.status).toBe('succeeded');
		expect(job.result).toEqual({
			objectKey: 'docx-exports/v1/export.docx',
			sha256: 'c'.repeat(64),
			byteSize: 2048,
			skippedPdfCount: 1
		});

		const attempt = sqlite
			.prepare(`SELECT * FROM docx_conversion_attempt WHERE id = ?`)
			.get('01950000-0000-7000-8000-000000000020') as {
			outcome: string;
			source_sha256: string;
			result_sha256: string;
		};
		expect(attempt.outcome).toBe('succeeded');
		expect(attempt.source_sha256).toBe(ARCHIVE_SHA);
		expect(attempt.result_sha256).toBe('c'.repeat(64));
	});

	it('fails a job with retryable failure, updating nextAvailableAt', async () => {
		const { store } = fixture();
		await store.enqueueImport(importCmd);

		const claimed = await store.claim({
			claimToken: 'token-fail-1',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 1
		});
		expect(claimed).toHaveLength(1);

		const failed = await store.fail({
			jobId: importCmd.id,
			claimToken: 'token-fail-1',
			attemptId: '01950000-0000-7000-8000-000000000030',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			failedAt: '2026-09-12T00:01:02.000Z',
			errorCode: 'transient_timeout',
			retryable: true,
			nextAvailableAt: '2026-09-12T00:01:32.000Z'
		});
		expect(failed).toBe(true);

		const job = await store.find(importCmd.id);
		expect(job?.status).toBe('failed');
		expect(job?.retryable).toBe(true);
		expect(job?.lastError).toBe('transient_timeout');
		expect(job?.availableAt).toBe('2026-09-12T00:01:32.000Z');

		// It should NOT be claimable before 00:01:32
		const earlyClaim = await store.claim({
			claimToken: 'token-early',
			claimedAt: '2026-09-12T00:01:20.000Z',
			staleBefore: '2026-09-12T00:00:00.000Z',
			limit: 1
		});
		expect(earlyClaim).toHaveLength(0);

		// It SHOULD be claimable at or after 00:01:32
		const retriedClaim = await store.claim({
			claimToken: 'token-retried',
			claimedAt: '2026-09-12T00:01:35.000Z',
			staleBefore: '2026-09-12T00:00:00.000Z',
			limit: 1
		});
		expect(retriedClaim).toHaveLength(1);
		expect(retriedClaim[0].job.attempts).toBe(2);
	});

	it('fails a job permanently, marking retryable=0 and preventing subsequent claims', async () => {
		const { store } = fixture();
		await store.enqueueImport(importCmd);

		await store.claim({
			claimToken: 'token-fail-perm',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 1
		});

		const failed = await store.fail({
			jobId: importCmd.id,
			claimToken: 'token-fail-perm',
			attemptId: '01950000-0000-7000-8000-000000000040',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			failedAt: '2026-09-12T00:01:02.000Z',
			errorCode: 'docx_integrity_failed',
			retryable: false,
			nextAvailableAt: '2026-09-12T00:01:02.000Z'
		});
		expect(failed).toBe(true);

		const job = await store.find(importCmd.id);
		expect(job?.status).toBe('failed');
		expect(job?.retryable).toBe(false);
		expect(job?.lastError).toBe('docx_integrity_failed');

		// Even far in the future, permanent failure is never claimed
		const futureClaim = await store.claim({
			claimToken: 'token-future',
			claimedAt: '2026-10-01T00:00:00.000Z',
			staleBefore: '2026-10-01T00:00:00.000Z',
			limit: 1
		});
		expect(futureClaim).toHaveLength(0);
	});
});
