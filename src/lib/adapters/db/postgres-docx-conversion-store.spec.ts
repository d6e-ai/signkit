import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresDocxConversionStore } from './postgres-docx-conversion-store';
import type {
	ClaimDocxConversionsCommand,
	CompleteDocxExportCommand,
	CompleteDocxImportCommand,
	EnqueueDocxExportCommand,
	EnqueueDocxImportCommand,
	FailDocxConversionCommand
} from '$lib/ports/docx-conversion-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}
type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	readonly transactionQueries: RecordedQuery[] = [];
	beginCalls: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result) => (result instanceof Error ? result : [...result]));
	}

	client(): ReturnType<typeof postgres> {
		const direct = this.#tag(this.directQueries);
		Object.assign(direct, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				return callback(this.#tag(this.transactionQueries));
			}
		});
		return direct as ReturnType<typeof postgres>;
	}

	#tag(target: RecordedQuery[]): ReturnType<typeof postgres> {
		const query = async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			target.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			const result = this.#results.shift();
			if (result === undefined) {
				throw new Error('Unexpected PostgreSQL query: ' + target[target.length - 1]?.text);
			}
			if (result instanceof Error) throw result;
			return result;
		};
		return query as ReturnType<typeof postgres>;
	}
}

const ENVELOPE_ID = '01920000-0000-7000-8000-000000000021';
const USER_ID = 'user-pg-tester';
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_KEY = 'archives/pg.git.gz';
const ARCHIVE_SHA = 'a'.repeat(64);

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
		name: 'PG Tester',
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

function fakeImportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: importCmd.id,
		envelopeId: ENVELOPE_ID,
		direction: 'import',
		requestKey: importCmd.requestKey,
		requestFingerprint: importCmd.requestFingerprint,
		status: 'pending',
		claimToken: null,
		attempts: 0,
		availableAt: new Date('2026-09-12T00:00:00.000Z'),
		lockedAt: null,
		retryable: true,
		lastError: null,
		sourceObjectKey: importCmd.sourceObjectKey,
		sourceSha256: importCmd.sourceSha256,
		sourceByteSize: 1024,
		sourceCommitSha: null,
		sourceArchiveKey: null,
		sourceArchiveSha256: null,
		targetPath: 'documents/agreement.md',
		expectedGeneration: 1,
		actorType: 'user',
		actorId: USER_ID,
		actorName: 'PG Tester',
		actorEmail: 'tester@example.com',
		idempotencyKey: 'idem-1',
		resultGeneration: null,
		resultCommitSha: null,
		resultArchiveSha256: null,
		resultObjectKey: null,
		resultSha256: null,
		resultByteSize: null,
		resultSkippedPdfCount: null,
		createdAt: new Date('2026-09-12T00:00:00.000Z'),
		updatedAt: new Date('2026-09-12T00:00:00.000Z'),
		completedAt: null,
		...overrides
	};
}

describe('PostgresDocxConversionStore', () => {
	it('enqueues an import job using ON CONFLICT DO NOTHING RETURNING *', async () => {
		const scripted = new ScriptedPostgres([[fakeImportRow()]]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const result = await store.enqueueImport(importCmd);
		expect(result.outcome).toBe('enqueued');
		if (result.outcome !== 'enqueued') return;
		expect(result.job.id).toBe(importCmd.id);
		expect(result.job.direction).toBe('import');
		expect(scripted.directQueries).toHaveLength(1);
		expect(scripted.directQueries[0].text).toContain(
			'ON CONFLICT (envelope_id, direction, request_key) DO NOTHING'
		);
		expect(scripted.directQueries[0].text).toContain('RETURNING');
	});

	it('detects existing job on conflict when request fingerprint matches', async () => {
		const scripted = new ScriptedPostgres([
			[], // INSERT returned 0 rows (conflict occurred)
			[fakeImportRow()] // SELECT existing returned matching row
		]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const result = await store.enqueueImport(importCmd);
		expect(result.outcome).toBe('existing');
		if (result.outcome !== 'existing') return;
		expect(result.job.id).toBe(importCmd.id);
		expect(scripted.directQueries).toHaveLength(2);
		expect(scripted.directQueries[1].text).toContain(
			'FROM docx_conversion_job WHERE envelope_id = ?'
		);
	});

	it('detects conflict on conflict when request fingerprint differs', async () => {
		const scripted = new ScriptedPostgres([
			[], // INSERT returned 0 rows
			[fakeImportRow({ requestFingerprint: 'different-fingerprint' })]
		]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const result = await store.enqueueImport(importCmd);
		expect(result.outcome).toBe('conflict');
	});

	it('claims pending jobs in a transaction with FOR UPDATE SKIP LOCKED', async () => {
		const claimedRow = fakeImportRow({
			status: 'processing',
			claimToken: 'token-1',
			attempts: 1,
			lockedAt: new Date('2026-09-12T00:01:00.000Z')
		});
		const scripted = new ScriptedPostgres([[claimedRow]]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const command: ClaimDocxConversionsCommand = {
			claimToken: 'token-1',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 5
		};
		const claimed = await store.claim(command);
		expect(claimed).toHaveLength(1);
		expect(claimed[0].job.id).toBe(importCmd.id);
		expect(claimed[0].claimToken).toBe('token-1');
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.transactionQueries).toHaveLength(1);
		expect(scripted.transactionQueries[0].text).toContain('FOR UPDATE SKIP LOCKED');
		expect(scripted.transactionQueries[0].text).toContain("status = 'processing'");
	});

	it('claims specific job with jobId in FOR UPDATE SKIP LOCKED', async () => {
		const claimedRow = fakeImportRow({
			status: 'processing',
			claimToken: 'token-single',
			attempts: 1
		});
		const scripted = new ScriptedPostgres([[claimedRow]]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const command: ClaimDocxConversionsCommand = {
			claimToken: 'token-single',
			claimedAt: '2026-09-12T00:01:00.000Z',
			staleBefore: '2026-09-11T23:56:00.000Z',
			limit: 5,
			jobId: importCmd.id
		};
		const claimed = await store.claim(command);
		expect(claimed).toHaveLength(1);
		expect(scripted.transactionQueries[0].text).toContain('AND id = ?');
	});

	it('completes an import job and inserts an attempt atomically', async () => {
		const scripted = new ScriptedPostgres([
			[{ sourceSha256: importCmd.sourceSha256, attempts: 1 }], // UPDATE docx_conversion_job RETURNING
			[] // INSERT INTO docx_conversion_attempt
		]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const command: CompleteDocxImportCommand = {
			jobId: importCmd.id,
			claimToken: 'token-1',
			attemptId: 'attempt-1',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			completedAt: '2026-09-12T00:01:05.000Z',
			resultGeneration: 2,
			resultCommitSha: 'commit-sha-2',
			resultArchiveSha256: 'archive-sha-2'
		};
		const ok = await store.completeImport(command);
		expect(ok).toBe(true);
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.transactionQueries).toHaveLength(2);
		expect(scripted.transactionQueries[0].text).toContain('UPDATE docx_conversion_job');
		expect(scripted.transactionQueries[0].text).toContain("status = 'succeeded'");
		expect(scripted.transactionQueries[1].text).toContain('INSERT INTO docx_conversion_attempt');
	});

	it('aborts completeImport when claimToken is stale and does not insert attempt', async () => {
		const scripted = new ScriptedPostgres([
			[] // UPDATE matched 0 rows (stale claim)
		]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const command: CompleteDocxImportCommand = {
			jobId: importCmd.id,
			claimToken: 'stale-token',
			attemptId: 'attempt-1',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			completedAt: '2026-09-12T00:01:05.000Z',
			resultGeneration: 2,
			resultCommitSha: 'commit-sha-2',
			resultArchiveSha256: 'archive-sha-2'
		};
		const ok = await store.completeImport(command);
		expect(ok).toBe(false);
		expect(scripted.transactionQueries).toHaveLength(1);
	});

	it('completes an export job and inserts an attempt atomically', async () => {
		const scripted = new ScriptedPostgres([
			[{ sourceArchiveSha256: ARCHIVE_SHA, attempts: 1 }],
			[]
		]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const command: CompleteDocxExportCommand = {
			jobId: exportCmd.id,
			claimToken: 'token-exp',
			attemptId: 'attempt-exp',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			completedAt: '2026-09-12T00:01:10.000Z',
			resultObjectKey: 'docx-exports/v1/export.docx',
			resultSha256: 'c'.repeat(64),
			resultByteSize: 2048,
			resultSkippedPdfCount: 0
		};
		const ok = await store.completeExport(command);
		expect(ok).toBe(true);
		expect(scripted.transactionQueries).toHaveLength(2);
		expect(scripted.transactionQueries[0].text).toContain('result_object_key = ?');
		expect(scripted.transactionQueries[1].text).toContain('INSERT INTO docx_conversion_attempt');
	});

	it('fails a job retryable and inserts attempt atomically', async () => {
		const scripted = new ScriptedPostgres([
			[{ sourceSha: importCmd.sourceSha256, attempts: 1 }],
			[]
		]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const command: FailDocxConversionCommand = {
			jobId: importCmd.id,
			claimToken: 'token-1',
			attemptId: 'attempt-fail',
			attemptNumber: 1,
			startedAt: '2026-09-12T00:01:00.000Z',
			failedAt: '2026-09-12T00:01:03.000Z',
			errorCode: 'transient_network_error',
			retryable: true,
			nextAvailableAt: '2026-09-12T00:01:33.000Z'
		};
		const ok = await store.fail(command);
		expect(ok).toBe(true);
		expect(scripted.transactionQueries).toHaveLength(2);
		expect(scripted.transactionQueries[0].text).toContain('retryable = true');
		expect(scripted.transactionQueries[1].text).toContain('INSERT INTO docx_conversion_attempt');
		expect(scripted.transactionQueries[1].values).toContain('retryable_failed');
	});

	it('finds a job by id', async () => {
		const scripted = new ScriptedPostgres([[fakeImportRow()]]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const job = await store.find(importCmd.id);
		expect(job).not.toBeNull();
		expect(job?.id).toBe(importCmd.id);
		expect(scripted.directQueries[0].text).toContain('WHERE id = ?');
	});

	it('finds a job by envelope_id, direction, and request_key', async () => {
		const scripted = new ScriptedPostgres([[fakeImportRow()]]);
		const store = new PostgresDocxConversionStore(scripted.client());

		const job = await store.findByRequestKey(ENVELOPE_ID, 'import', importCmd.requestKey);
		expect(job).not.toBeNull();
		expect(job?.id).toBe(importCmd.id);
		expect(scripted.directQueries[0].text).toContain(
			'WHERE envelope_id = ? AND direction = ? AND request_key = ?'
		);
	});
});
