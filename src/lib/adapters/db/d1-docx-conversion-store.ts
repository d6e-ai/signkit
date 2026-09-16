import {
	boundDocxConversionClaimLimit,
	type ClaimDocxConversionsCommand,
	type ClaimedDocxConversionJob,
	type CompleteDocxExportCommand,
	type CompleteDocxImportCommand,
	type DocxConversionDirection,
	type DocxConversionJob,
	type DocxConversionJobBase,
	type DocxConversionStatus,
	type DocxConversionStore,
	type EnqueueDocxConversionResult,
	type EnqueueDocxExportCommand,
	type EnqueueDocxImportCommand,
	type FailDocxConversionCommand
} from '$lib/ports/docx-conversion-store';

interface DocxJobRow {
	id: string;
	envelope_id: string;
	direction: 'import' | 'export';
	request_key: string;
	request_fingerprint: string;
	status: DocxConversionStatus;
	claim_token: string | null;
	attempts: number;
	available_at: string;
	locked_at: string | null;
	retryable: number;
	last_error: string | null;
	source_object_key: string | null;
	source_sha256: string | null;
	source_byte_size: number | null;
	source_commit_sha: string | null;
	source_archive_key: string | null;
	source_archive_sha256: string | null;
	target_path: string | null;
	expected_generation: number | null;
	actor_type: string | null;
	actor_id: string | null;
	actor_name: string | null;
	actor_email: string | null;
	idempotency_key: string | null;
	result_generation: number | null;
	result_commit_sha: string | null;
	result_archive_sha256: string | null;
	result_object_key: string | null;
	result_sha256: string | null;
	result_byte_size: number | null;
	result_skipped_pdf_count: number | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

const JOB_COLUMNS: string = `id, envelope_id, direction, request_key, request_fingerprint,
	status, claim_token, attempts, available_at, locked_at, retryable, last_error,
	source_object_key, source_sha256, source_byte_size, source_commit_sha,
	source_archive_key, source_archive_sha256, target_path, expected_generation,
	actor_type, actor_id, actor_name, actor_email, idempotency_key,
	result_generation, result_commit_sha, result_archive_sha256,
	result_object_key, result_sha256, result_byte_size, result_skipped_pdf_count,
	created_at, updated_at, completed_at`;

function mapD1RowToJob(row: DocxJobRow): DocxConversionJob {
	const base: DocxConversionJobBase = {
		id: row.id,
		envelopeId: row.envelope_id,
		requestKey: row.request_key,
		requestFingerprint: row.request_fingerprint,
		status: row.status,
		attempts: Number(row.attempts),
		availableAt: row.available_at,
		retryable: row.retryable === 1,
		lastError: row.last_error ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at ?? null,
		lockedAt: row.locked_at ?? null
	};

	if (row.direction === 'import') {
		const result =
			row.result_generation !== null &&
			row.result_commit_sha !== null &&
			row.result_archive_sha256 !== null
				? {
						generation: Number(row.result_generation),
						commitSha: row.result_commit_sha,
						archiveSha256: row.result_archive_sha256
					}
				: null;

		return {
			...base,
			direction: 'import',
			sourceObjectKey: row.source_object_key!,
			sourceSha256: row.source_sha256!,
			sourceByteSize: Number(row.source_byte_size!),
			targetPath: row.target_path! as `documents/${string}.md`,
			expectedGeneration: Number(row.expected_generation!),
			actor: {
				id: row.actor_id!,
				name: row.actor_name!,
				email: row.actor_email!,
				type: row.actor_type! as 'user' | 'agent' | 'system'
			},
			idempotencyKey: row.idempotency_key!,
			result
		};
	}

	const result =
		row.result_object_key !== null && row.result_sha256 !== null && row.result_byte_size !== null
			? {
					objectKey: row.result_object_key,
					sha256: row.result_sha256,
					byteSize: Number(row.result_byte_size),
					skippedPdfCount: Number(row.result_skipped_pdf_count ?? 0)
				}
			: null;

	return {
		...base,
		direction: 'export',
		sourceCommitSha: row.source_commit_sha!,
		sourceArchiveKey: row.source_archive_key!,
		sourceArchiveSha256: row.source_archive_sha256!,
		result
	};
}

export class D1DocxConversionStore implements DocxConversionStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async enqueueImport(command: EnqueueDocxImportCommand): Promise<EnqueueDocxConversionResult> {
		const insertResult: D1Result = await this.#database
			.prepare(
				`INSERT INTO docx_conversion_job (
					id, envelope_id, direction, request_key, request_fingerprint,
					status, claim_token, attempts, available_at, locked_at, retryable,
					last_error, source_object_key, source_sha256, source_byte_size,
					source_commit_sha, source_archive_key, source_archive_sha256,
					target_path, expected_generation, actor_type, actor_id, actor_name,
					actor_email, idempotency_key, created_at, updated_at
				) VALUES (
					?, ?, 'import', ?, ?,
					'pending', NULL, 0, ?, NULL, 1,
					NULL, ?, ?, ?,
					NULL, NULL, NULL,
					?, ?, ?, ?, ?,
					?, ?, ?, ?
				)
				ON CONFLICT (envelope_id, direction, request_key) DO NOTHING`
			)
			.bind(
				command.id,
				command.envelopeId,
				command.requestKey,
				command.requestFingerprint,
				command.createdAt,
				command.sourceObjectKey,
				command.sourceSha256,
				command.sourceByteSize,
				command.targetPath,
				command.expectedGeneration,
				command.actor.type,
				command.actor.id,
				command.actor.name,
				command.actor.email,
				command.idempotencyKey,
				command.createdAt,
				command.createdAt
			)
			.run();

		if ((insertResult.meta.changes ?? 0) === 1) {
			const job = await this.find(command.id);
			if (job !== null) return { outcome: 'enqueued', job };
		}

		const existing = await this.findByRequestKey(command.envelopeId, 'import', command.requestKey);
		if (existing === null) {
			throw new Error('Failed to enqueue or retrieve existing DOCX import job');
		}
		if (existing.requestFingerprint === command.requestFingerprint) {
			return { outcome: 'existing', job: existing };
		}
		return { outcome: 'conflict' };
	}

	async enqueueExport(command: EnqueueDocxExportCommand): Promise<EnqueueDocxConversionResult> {
		const insertResult: D1Result = await this.#database
			.prepare(
				`INSERT INTO docx_conversion_job (
					id, envelope_id, direction, request_key, request_fingerprint,
					status, claim_token, attempts, available_at, locked_at, retryable,
					last_error, source_object_key, source_sha256, source_byte_size,
					source_commit_sha, source_archive_key, source_archive_sha256,
					target_path, expected_generation, actor_type, actor_id, actor_name,
					actor_email, idempotency_key, created_at, updated_at
				) VALUES (
					?, ?, 'export', ?, ?,
					'pending', NULL, 0, ?, NULL, 1,
					NULL, NULL, NULL, NULL,
					?, ?, ?,
					NULL, NULL, NULL, NULL, NULL,
					NULL, NULL, ?, ?
				)
				ON CONFLICT (envelope_id, direction, request_key) DO NOTHING`
			)
			.bind(
				command.id,
				command.envelopeId,
				command.requestKey,
				command.requestFingerprint,
				command.createdAt,
				command.sourceCommitSha,
				command.sourceArchiveKey,
				command.sourceArchiveSha256,
				command.createdAt,
				command.createdAt
			)
			.run();

		if ((insertResult.meta.changes ?? 0) === 1) {
			const job = await this.find(command.id);
			if (job !== null) return { outcome: 'enqueued', job };
		}

		const existing = await this.findByRequestKey(command.envelopeId, 'export', command.requestKey);
		if (existing === null) {
			throw new Error('Failed to enqueue or retrieve existing DOCX export job');
		}
		if (existing.requestFingerprint === command.requestFingerprint) {
			return { outcome: 'existing', job: existing };
		}
		return { outcome: 'conflict' };
	}

	async claim(command: ClaimDocxConversionsCommand): Promise<readonly ClaimedDocxConversionJob[]> {
		const limit: number = boundDocxConversionClaimLimit(command.limit);
		const claimWhere: string = command.jobId
			? `WHERE (
					(status = 'pending' AND available_at <= ?)
					OR (status = 'failed' AND retryable = 1 AND available_at <= ?)
					OR (status = 'processing' AND locked_at < ?)
				) AND id = ?
				ORDER BY available_at ASC, created_at ASC, id ASC
				LIMIT 1`
			: `WHERE (
					(status = 'pending' AND available_at <= ?)
					OR (status = 'failed' AND retryable = 1 AND available_at <= ?)
					OR (status = 'processing' AND locked_at < ?)
				)
				ORDER BY available_at ASC, created_at ASC, id ASC
				LIMIT ?`;

		const claimUpdate: D1PreparedStatement = command.jobId
			? this.#database
					.prepare(
						`UPDATE docx_conversion_job
						 SET status = 'processing', claim_token = ?, locked_at = ?, attempts = attempts + 1,
							updated_at = ?
						 WHERE id IN (SELECT id FROM docx_conversion_job ${claimWhere})`
					)
					.bind(
						command.claimToken,
						command.claimedAt,
						command.claimedAt,
						command.claimedAt,
						command.claimedAt,
						command.staleBefore,
						command.jobId
					)
			: this.#database
					.prepare(
						`UPDATE docx_conversion_job
						 SET status = 'processing', claim_token = ?, locked_at = ?, attempts = attempts + 1,
							updated_at = ?
						 WHERE id IN (SELECT id FROM docx_conversion_job ${claimWhere})`
					)
					.bind(
						command.claimToken,
						command.claimedAt,
						command.claimedAt,
						command.claimedAt,
						command.claimedAt,
						command.staleBefore,
						limit
					);

		const readClaimed: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${JOB_COLUMNS} FROM docx_conversion_job
				 WHERE status = 'processing' AND claim_token = ?
				 ORDER BY available_at ASC, created_at ASC, id ASC`
			)
			.bind(command.claimToken);

		const results: D1Result[] = await this.#database.batch([claimUpdate, readClaimed]);
		const rows: readonly DocxJobRow[] = (results[1]?.results ?? []) as unknown as DocxJobRow[];
		return rows.map((row: DocxJobRow): ClaimedDocxConversionJob => ({
			job: mapD1RowToJob(row),
			claimToken: command.claimToken,
			startedAt: command.claimedAt
		}));
	}

	async completeImport(command: CompleteDocxImportCommand): Promise<boolean> {
		const insertAttempt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO docx_conversion_attempt (
					id, job_id, attempt_number, outcome, error_code,
					source_sha256, result_sha256, started_at, finished_at
				)
				SELECT ?, id, ?, 'succeeded', NULL, source_sha256, ?, ?, ?
				FROM docx_conversion_job
				WHERE id = ? AND status = 'processing' AND claim_token = ? AND attempts = ?`
			)
			.bind(
				command.attemptId,
				command.attemptNumber,
				command.resultArchiveSha256,
				command.startedAt,
				command.completedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			);

		const updateJob: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE docx_conversion_job
				 SET status = 'succeeded', claim_token = NULL, locked_at = NULL, retryable = 0,
					last_error = NULL, completed_at = ?, updated_at = ?,
					result_generation = ?, result_commit_sha = ?, result_archive_sha256 = ?
				 WHERE id = ? AND status = 'processing' AND claim_token = ? AND attempts = ?`
			)
			.bind(
				command.completedAt,
				command.completedAt,
				command.resultGeneration,
				command.resultCommitSha,
				command.resultArchiveSha256,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			);

		const results: D1Result[] = await this.#database.batch([insertAttempt, updateJob]);
		return (results[1]?.meta.changes ?? 0) === 1;
	}

	async completeExport(command: CompleteDocxExportCommand): Promise<boolean> {
		const insertAttempt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO docx_conversion_attempt (
					id, job_id, attempt_number, outcome, error_code,
					source_sha256, result_sha256, started_at, finished_at
				)
				SELECT ?, id, ?, 'succeeded', NULL, source_archive_sha256, ?, ?, ?
				FROM docx_conversion_job
				WHERE id = ? AND status = 'processing' AND claim_token = ? AND attempts = ?`
			)
			.bind(
				command.attemptId,
				command.attemptNumber,
				command.resultSha256,
				command.startedAt,
				command.completedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			);

		const updateJob: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE docx_conversion_job
				 SET status = 'succeeded', claim_token = NULL, locked_at = NULL, retryable = 0,
					last_error = NULL, completed_at = ?, updated_at = ?,
					result_object_key = ?, result_sha256 = ?, result_byte_size = ?, result_skipped_pdf_count = ?
				 WHERE id = ? AND status = 'processing' AND claim_token = ? AND attempts = ?`
			)
			.bind(
				command.completedAt,
				command.completedAt,
				command.resultObjectKey,
				command.resultSha256,
				command.resultByteSize,
				command.resultSkippedPdfCount,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			);

		const results: D1Result[] = await this.#database.batch([insertAttempt, updateJob]);
		return (results[1]?.meta.changes ?? 0) === 1;
	}

	async fail(command: FailDocxConversionCommand): Promise<boolean> {
		const outcome: string = command.retryable ? 'retryable_failed' : 'permanently_failed';
		const insertAttempt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO docx_conversion_attempt (
					id, job_id, attempt_number, outcome, error_code,
					source_sha256, result_sha256, started_at, finished_at
				)
				SELECT ?, id, ?, ?, ?, COALESCE(source_sha256, source_archive_sha256), NULL, ?, ?
				FROM docx_conversion_job
				WHERE id = ? AND status = 'processing' AND claim_token = ? AND attempts = ?`
			)
			.bind(
				command.attemptId,
				command.attemptNumber,
				outcome,
				command.errorCode,
				command.startedAt,
				command.failedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			);

		const updateJob: D1PreparedStatement = command.retryable
			? this.#database
					.prepare(
						`UPDATE docx_conversion_job
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 1,
							last_error = ?, available_at = ?, updated_at = ?
						 WHERE id = ? AND status = 'processing' AND claim_token = ? AND attempts = ?`
					)
					.bind(
						command.errorCode,
						command.nextAvailableAt,
						command.failedAt,
						command.jobId,
						command.claimToken,
						command.attemptNumber
					)
			: this.#database
					.prepare(
						`UPDATE docx_conversion_job
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 0,
							last_error = ?, available_at = ?, updated_at = ?, completed_at = ?
						 WHERE id = ? AND status = 'processing' AND claim_token = ? AND attempts = ?`
					)
					.bind(
						command.errorCode,
						command.nextAvailableAt,
						command.failedAt,
						command.failedAt,
						command.jobId,
						command.claimToken,
						command.attemptNumber
					);

		const results: D1Result[] = await this.#database.batch([insertAttempt, updateJob]);
		return (results[1]?.meta.changes ?? 0) === 1;
	}

	async find(jobId: string): Promise<DocxConversionJob | null> {
		const result: D1Result<DocxJobRow> = await this.#database
			.prepare(`SELECT ${JOB_COLUMNS} FROM docx_conversion_job WHERE id = ?`)
			.bind(jobId)
			.all();
		const row: DocxJobRow | undefined = result.results[0];
		return row === undefined ? null : mapD1RowToJob(row);
	}

	async findByRequestKey(
		envelopeId: string,
		direction: DocxConversionDirection,
		requestKey: string
	): Promise<DocxConversionJob | null> {
		const result: D1Result<DocxJobRow> = await this.#database
			.prepare(
				`SELECT ${JOB_COLUMNS} FROM docx_conversion_job
				 WHERE envelope_id = ? AND direction = ? AND request_key = ?`
			)
			.bind(envelopeId, direction, requestKey)
			.all();
		const row: DocxJobRow | undefined = result.results[0];
		return row === undefined ? null : mapD1RowToJob(row);
	}
}
