import type postgres from 'postgres';
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

class DocxConversionRollback<T> {
	constructor(readonly result: T) {}
}

interface PostgresDocxJobRow {
	id: string;
	envelopeId: string;
	direction: 'import' | 'export';
	requestKey: string;
	requestFingerprint: string;
	status: DocxConversionStatus;
	claimToken: string | null;
	attempts: number | string;
	availableAt: Date | string;
	lockedAt: Date | string | null;
	retryable: boolean;
	lastError: string | null;
	sourceObjectKey: string | null;
	sourceSha256: string | null;
	sourceByteSize: number | string | null;
	sourceCommitSha: string | null;
	sourceArchiveKey: string | null;
	sourceArchiveSha256: string | null;
	targetPath: string | null;
	expectedGeneration: number | string | null;
	actorType: string | null;
	actorId: string | null;
	actorName: string | null;
	actorEmail: string | null;
	idempotencyKey: string | null;
	resultGeneration: number | string | null;
	resultCommitSha: string | null;
	resultArchiveSha256: string | null;
	resultObjectKey: string | null;
	resultSha256: string | null;
	resultByteSize: number | string | null;
	resultSkippedPdfCount: number | string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	completedAt: Date | string | null;
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : String(value);
}

function mapPostgresRowToJob(row: PostgresDocxJobRow): DocxConversionJob {
	const base: DocxConversionJobBase = {
		id: row.id,
		envelopeId: row.envelopeId,
		requestKey: row.requestKey,
		requestFingerprint: row.requestFingerprint,
		status: row.status,
		attempts: Number(row.attempts),
		availableAt: toIso(row.availableAt),
		retryable: Boolean(row.retryable),
		lastError: row.lastError ?? null,
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
		completedAt: row.completedAt ? toIso(row.completedAt) : null,
		lockedAt: row.lockedAt ? toIso(row.lockedAt) : null
	};

	if (row.direction === 'import') {
		const result =
			row.resultGeneration !== null &&
			row.resultCommitSha !== null &&
			row.resultArchiveSha256 !== null
				? {
						generation: Number(row.resultGeneration),
						commitSha: row.resultCommitSha,
						archiveSha256: row.resultArchiveSha256
					}
				: null;

		return {
			...base,
			direction: 'import',
			sourceObjectKey: row.sourceObjectKey!,
			sourceSha256: row.sourceSha256!,
			sourceByteSize: Number(row.sourceByteSize!),
			targetPath: row.targetPath! as `documents/${string}.md`,
			expectedGeneration: Number(row.expectedGeneration!),
			actor: {
				id: row.actorId!,
				name: row.actorName!,
				email: row.actorEmail!,
				type: row.actorType! as 'user' | 'agent' | 'system'
			},
			idempotencyKey: row.idempotencyKey!,
			result
		};
	}

	const result =
		row.resultObjectKey !== null && row.resultSha256 !== null && row.resultByteSize !== null
			? {
					objectKey: row.resultObjectKey,
					sha256: row.resultSha256,
					byteSize: Number(row.resultByteSize),
					skippedPdfCount: Number(row.resultSkippedPdfCount ?? 0)
				}
			: null;

	return {
		...base,
		direction: 'export',
		sourceCommitSha: row.sourceCommitSha!,
		sourceArchiveKey: row.sourceArchiveKey!,
		sourceArchiveSha256: row.sourceArchiveSha256!,
		result
	};
}

export class PostgresDocxConversionStore implements DocxConversionStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async enqueueImport(command: EnqueueDocxImportCommand): Promise<EnqueueDocxConversionResult> {
		const inserted = await this.#sql<PostgresDocxJobRow[]>`
			INSERT INTO docx_conversion_job (
				id, envelope_id, direction, request_key, request_fingerprint,
				status, claim_token, attempts, available_at, locked_at, retryable,
				last_error, source_object_key, source_sha256, source_byte_size,
				source_commit_sha, source_archive_key, source_archive_sha256,
				target_path, expected_generation, actor_type, actor_id, actor_name,
				actor_email, idempotency_key, created_at, updated_at
			) VALUES (
				${command.id}, ${command.envelopeId}, 'import', ${command.requestKey}, ${command.requestFingerprint},
				'pending', NULL, 0, ${command.createdAt}::timestamptz, NULL, true,
				NULL, ${command.sourceObjectKey}, ${command.sourceSha256}, ${command.sourceByteSize},
				NULL, NULL, NULL,
				${command.targetPath}, ${command.expectedGeneration}, ${command.actor.type}, ${command.actor.id},
				${command.actor.name}, ${command.actor.email}, ${command.idempotencyKey},
				${command.createdAt}::timestamptz, ${command.createdAt}::timestamptz
			)
			ON CONFLICT (envelope_id, direction, request_key) DO NOTHING
			RETURNING
				id, envelope_id AS "envelopeId", direction, request_key AS "requestKey",
				request_fingerprint AS "requestFingerprint", status, claim_token AS "claimToken",
				attempts, available_at AS "availableAt", locked_at AS "lockedAt", retryable,
				last_error AS "lastError", source_object_key AS "sourceObjectKey",
				source_sha256 AS "sourceSha256", source_byte_size AS "sourceByteSize",
				source_commit_sha AS "sourceCommitSha", source_archive_key AS "sourceArchiveKey",
				source_archive_sha256 AS "sourceArchiveSha256", target_path AS "targetPath",
				expected_generation AS "expectedGeneration", actor_type AS "actorType",
				actor_id AS "actorId", actor_name AS "actorName", actor_email AS "actorEmail",
				idempotency_key AS "idempotencyKey", result_generation AS "resultGeneration",
				result_commit_sha AS "resultCommitSha", result_archive_sha256 AS "resultArchiveSha256",
				result_object_key AS "resultObjectKey", result_sha256 AS "resultSha256",
				result_byte_size AS "resultByteSize", result_skipped_pdf_count AS "resultSkippedPdfCount",
				created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"`;

		if (inserted.length === 1) {
			return { outcome: 'enqueued', job: mapPostgresRowToJob(inserted[0]) };
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
		const inserted = await this.#sql<PostgresDocxJobRow[]>`
			INSERT INTO docx_conversion_job (
				id, envelope_id, direction, request_key, request_fingerprint,
				status, claim_token, attempts, available_at, locked_at, retryable,
				last_error, source_object_key, source_sha256, source_byte_size,
				source_commit_sha, source_archive_key, source_archive_sha256,
				target_path, expected_generation, actor_type, actor_id, actor_name,
				actor_email, idempotency_key, created_at, updated_at
			) VALUES (
				${command.id}, ${command.envelopeId}, 'export', ${command.requestKey}, ${command.requestFingerprint},
				'pending', NULL, 0, ${command.createdAt}::timestamptz, NULL, true,
				NULL, NULL, NULL, NULL,
				${command.sourceCommitSha}, ${command.sourceArchiveKey}, ${command.sourceArchiveSha256},
				NULL, NULL, NULL, NULL, NULL,
				NULL, NULL,
				${command.createdAt}::timestamptz, ${command.createdAt}::timestamptz
			)
			ON CONFLICT (envelope_id, direction, request_key) DO NOTHING
			RETURNING
				id, envelope_id AS "envelopeId", direction, request_key AS "requestKey",
				request_fingerprint AS "requestFingerprint", status, claim_token AS "claimToken",
				attempts, available_at AS "availableAt", locked_at AS "lockedAt", retryable,
				last_error AS "lastError", source_object_key AS "sourceObjectKey",
				source_sha256 AS "sourceSha256", source_byte_size AS "sourceByteSize",
				source_commit_sha AS "sourceCommitSha", source_archive_key AS "sourceArchiveKey",
				source_archive_sha256 AS "sourceArchiveSha256", target_path AS "targetPath",
				expected_generation AS "expectedGeneration", actor_type AS "actorType",
				actor_id AS "actorId", actor_name AS "actorName", actor_email AS "actorEmail",
				idempotency_key AS "idempotencyKey", result_generation AS "resultGeneration",
				result_commit_sha AS "resultCommitSha", result_archive_sha256 AS "resultArchiveSha256",
				result_object_key AS "resultObjectKey", result_sha256 AS "resultSha256",
				result_byte_size AS "resultByteSize", result_skipped_pdf_count AS "resultSkippedPdfCount",
				created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"`;

		if (inserted.length === 1) {
			return { outcome: 'enqueued', job: mapPostgresRowToJob(inserted[0]) };
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
		return await this.#sql.begin(
			async (sql: postgres.TransactionSql): Promise<readonly ClaimedDocxConversionJob[]> => {
				const rows: PostgresDocxJobRow[] = command.jobId
					? await sql<PostgresDocxJobRow[]>`
						WITH candidates AS (
							SELECT id FROM docx_conversion_job
							WHERE (
								(status = 'pending' AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'failed' AND retryable AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing' AND locked_at < ${command.staleBefore}::timestamptz)
							)
							AND id = ${command.jobId}
							ORDER BY available_at ASC, created_at ASC, id ASC
							LIMIT 1
							FOR UPDATE SKIP LOCKED
						)
						UPDATE docx_conversion_job AS job
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}::timestamptz,
							attempts = job.attempts + 1,
							updated_at = ${command.claimedAt}::timestamptz
						FROM candidates
						WHERE job.id = candidates.id
						RETURNING
							job.id AS "id",
							job.envelope_id AS "envelopeId",
							job.direction AS "direction",
							job.request_key AS "requestKey",
							job.request_fingerprint AS "requestFingerprint",
							job.status AS "status",
							job.claim_token AS "claimToken",
							job.attempts AS "attempts",
							job.available_at AS "availableAt",
							job.locked_at AS "lockedAt",
							job.retryable AS "retryable",
							job.last_error AS "lastError",
							job.source_object_key AS "sourceObjectKey",
							job.source_sha256 AS "sourceSha256",
							job.source_byte_size AS "sourceByteSize",
							job.source_commit_sha AS "sourceCommitSha",
							job.source_archive_key AS "sourceArchiveKey",
							job.source_archive_sha256 AS "sourceArchiveSha256",
							job.target_path AS "targetPath",
							job.expected_generation AS "expectedGeneration",
							job.actor_type AS "actorType",
							job.actor_id AS "actorId",
							job.actor_name AS "actorName",
							job.actor_email AS "actorEmail",
							job.idempotency_key AS "idempotencyKey",
							job.result_generation AS "resultGeneration",
							job.result_commit_sha AS "resultCommitSha",
							job.result_archive_sha256 AS "resultArchiveSha256",
							job.result_object_key AS "resultObjectKey",
							job.result_sha256 AS "resultSha256",
							job.result_byte_size AS "resultByteSize",
							job.result_skipped_pdf_count AS "resultSkippedPdfCount",
							job.created_at AS "createdAt",
							job.updated_at AS "updatedAt",
							job.completed_at AS "completedAt"`
					: await sql<PostgresDocxJobRow[]>`
						WITH candidates AS (
							SELECT id FROM docx_conversion_job
							WHERE (
								(status = 'pending' AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'failed' AND retryable AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing' AND locked_at < ${command.staleBefore}::timestamptz)
							)
							ORDER BY available_at ASC, created_at ASC, id ASC
							LIMIT ${limit}
							FOR UPDATE SKIP LOCKED
						)
						UPDATE docx_conversion_job AS job
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}::timestamptz,
							attempts = job.attempts + 1,
							updated_at = ${command.claimedAt}::timestamptz
						FROM candidates
						WHERE job.id = candidates.id
						RETURNING
							job.id AS "id",
							job.envelope_id AS "envelopeId",
							job.direction AS "direction",
							job.request_key AS "requestKey",
							job.request_fingerprint AS "requestFingerprint",
							job.status AS "status",
							job.claim_token AS "claimToken",
							job.attempts AS "attempts",
							job.available_at AS "availableAt",
							job.locked_at AS "lockedAt",
							job.retryable AS "retryable",
							job.last_error AS "lastError",
							job.source_object_key AS "sourceObjectKey",
							job.source_sha256 AS "sourceSha256",
							job.source_byte_size AS "sourceByteSize",
							job.source_commit_sha AS "sourceCommitSha",
							job.source_archive_key AS "sourceArchiveKey",
							job.source_archive_sha256 AS "sourceArchiveSha256",
							job.target_path AS "targetPath",
							job.expected_generation AS "expectedGeneration",
							job.actor_type AS "actorType",
							job.actor_id AS "actorId",
							job.actor_name AS "actorName",
							job.actor_email AS "actorEmail",
							job.idempotency_key AS "idempotencyKey",
							job.result_generation AS "resultGeneration",
							job.result_commit_sha AS "resultCommitSha",
							job.result_archive_sha256 AS "resultArchiveSha256",
							job.result_object_key AS "resultObjectKey",
							job.result_sha256 AS "resultSha256",
							job.result_byte_size AS "resultByteSize",
							job.result_skipped_pdf_count AS "resultSkippedPdfCount",
							job.created_at AS "createdAt",
							job.updated_at AS "updatedAt",
							job.completed_at AS "completedAt"`;

				return rows.map((row: PostgresDocxJobRow): ClaimedDocxConversionJob => ({
					job: mapPostgresRowToJob(row),
					claimToken: command.claimToken,
					startedAt: command.claimedAt
				}));
			}
		);
	}

	async completeImport(command: CompleteDocxImportCommand): Promise<boolean> {
		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql): Promise<boolean> => {
				const updated = await sql<{ sourceSha256: string | null; attempts: number }[]>`
					UPDATE docx_conversion_job
					SET status = 'succeeded', claim_token = NULL, locked_at = NULL, retryable = false,
						last_error = NULL, completed_at = ${command.completedAt}::timestamptz,
						updated_at = ${command.completedAt}::timestamptz,
						result_generation = ${command.resultGeneration},
						result_commit_sha = ${command.resultCommitSha},
						result_archive_sha256 = ${command.resultArchiveSha256}
					WHERE id = ${command.jobId}
						AND status = 'processing'
						AND claim_token = ${command.claimToken}
						AND attempts = ${command.attemptNumber}
					RETURNING source_sha256 AS "sourceSha256", attempts`;

				if (updated.length !== 1) {
					throw new DocxConversionRollback(false);
				}

				await sql`
					INSERT INTO docx_conversion_attempt (
						id, job_id, attempt_number, outcome, error_code,
						source_sha256, result_sha256, started_at, finished_at
					) VALUES (
						${command.attemptId}, ${command.jobId}, ${command.attemptNumber},
						'succeeded', NULL, ${updated[0].sourceSha256}, ${command.resultArchiveSha256},
						${command.startedAt}::timestamptz, ${command.completedAt}::timestamptz
					)`;

				return true;
			});
		} catch (error: unknown) {
			if (error instanceof DocxConversionRollback) return error.result;
			throw error;
		}
	}

	async completeExport(command: CompleteDocxExportCommand): Promise<boolean> {
		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql): Promise<boolean> => {
				const updated = await sql<{ sourceArchiveSha256: string | null; attempts: number }[]>`
					UPDATE docx_conversion_job
					SET status = 'succeeded', claim_token = NULL, locked_at = NULL, retryable = false,
						last_error = NULL, completed_at = ${command.completedAt}::timestamptz,
						updated_at = ${command.completedAt}::timestamptz,
						result_object_key = ${command.resultObjectKey},
						result_sha256 = ${command.resultSha256},
						result_byte_size = ${command.resultByteSize},
						result_skipped_pdf_count = ${command.resultSkippedPdfCount}
					WHERE id = ${command.jobId}
						AND status = 'processing'
						AND claim_token = ${command.claimToken}
						AND attempts = ${command.attemptNumber}
					RETURNING source_archive_sha256 AS "sourceArchiveSha256", attempts`;

				if (updated.length !== 1) {
					throw new DocxConversionRollback(false);
				}

				await sql`
					INSERT INTO docx_conversion_attempt (
						id, job_id, attempt_number, outcome, error_code,
						source_sha256, result_sha256, started_at, finished_at
					) VALUES (
						${command.attemptId}, ${command.jobId}, ${command.attemptNumber},
						'succeeded', NULL, ${updated[0].sourceArchiveSha256}, ${command.resultSha256},
						${command.startedAt}::timestamptz, ${command.completedAt}::timestamptz
					)`;

				return true;
			});
		} catch (error: unknown) {
			if (error instanceof DocxConversionRollback) return error.result;
			throw error;
		}
	}

	async fail(command: FailDocxConversionCommand): Promise<boolean> {
		const outcome: 'retryable_failed' | 'permanently_failed' = command.retryable
			? 'retryable_failed'
			: 'permanently_failed';

		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql): Promise<boolean> => {
				const updated = command.retryable
					? await sql<{ sourceSha: string | null; attempts: number }[]>`
						UPDATE docx_conversion_job
						SET status = 'failed', claim_token = NULL, locked_at = NULL,
							retryable = true, last_error = ${command.errorCode},
							available_at = ${command.nextAvailableAt}::timestamptz,
							updated_at = ${command.failedAt}::timestamptz
						WHERE id = ${command.jobId}
							AND status = 'processing'
							AND claim_token = ${command.claimToken}
							AND attempts = ${command.attemptNumber}
						RETURNING COALESCE(source_sha256, source_archive_sha256) AS "sourceSha", attempts`
					: await sql<{ sourceSha: string | null; attempts: number }[]>`
						UPDATE docx_conversion_job
						SET status = 'failed', claim_token = NULL, locked_at = NULL,
							retryable = false, last_error = ${command.errorCode},
							available_at = ${command.nextAvailableAt}::timestamptz,
							updated_at = ${command.failedAt}::timestamptz,
							completed_at = ${command.failedAt}::timestamptz
						WHERE id = ${command.jobId}
							AND status = 'processing'
							AND claim_token = ${command.claimToken}
							AND attempts = ${command.attemptNumber}
						RETURNING COALESCE(source_sha256, source_archive_sha256) AS "sourceSha", attempts`;

				if (updated.length !== 1) {
					throw new DocxConversionRollback(false);
				}

				await sql`
					INSERT INTO docx_conversion_attempt (
						id, job_id, attempt_number, outcome, error_code,
						source_sha256, result_sha256, started_at, finished_at
					) VALUES (
						${command.attemptId}, ${command.jobId}, ${command.attemptNumber},
						${outcome}, ${command.errorCode}, ${updated[0].sourceSha}, NULL,
						${command.startedAt}::timestamptz, ${command.failedAt}::timestamptz
					)`;

				return true;
			});
		} catch (error: unknown) {
			if (error instanceof DocxConversionRollback) return error.result;
			throw error;
		}
	}

	async find(jobId: string): Promise<DocxConversionJob | null> {
		const rows = await this.#sql<PostgresDocxJobRow[]>`
			SELECT
				id, envelope_id AS "envelopeId", direction, request_key AS "requestKey",
				request_fingerprint AS "requestFingerprint", status, claim_token AS "claimToken",
				attempts, available_at AS "availableAt", locked_at AS "lockedAt", retryable,
				last_error AS "lastError", source_object_key AS "sourceObjectKey",
				source_sha256 AS "sourceSha256", source_byte_size AS "sourceByteSize",
				source_commit_sha AS "sourceCommitSha", source_archive_key AS "sourceArchiveKey",
				source_archive_sha256 AS "sourceArchiveSha256", target_path AS "targetPath",
				expected_generation AS "expectedGeneration", actor_type AS "actorType",
				actor_id AS "actorId", actor_name AS "actorName", actor_email AS "actorEmail",
				idempotency_key AS "idempotencyKey", result_generation AS "resultGeneration",
				result_commit_sha AS "resultCommitSha", result_archive_sha256 AS "resultArchiveSha256",
				result_object_key AS "resultObjectKey", result_sha256 AS "resultSha256",
				result_byte_size AS "resultByteSize", result_skipped_pdf_count AS "resultSkippedPdfCount",
				created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"
			FROM docx_conversion_job
			WHERE id = ${jobId}`;

		return rows.length === 1 ? mapPostgresRowToJob(rows[0]) : null;
	}

	async findByRequestKey(
		envelopeId: string,
		direction: DocxConversionDirection,
		requestKey: string
	): Promise<DocxConversionJob | null> {
		const rows = await this.#sql<PostgresDocxJobRow[]>`
			SELECT
				id, envelope_id AS "envelopeId", direction, request_key AS "requestKey",
				request_fingerprint AS "requestFingerprint", status, claim_token AS "claimToken",
				attempts, available_at AS "availableAt", locked_at AS "lockedAt", retryable,
				last_error AS "lastError", source_object_key AS "sourceObjectKey",
				source_sha256 AS "sourceSha256", source_byte_size AS "sourceByteSize",
				source_commit_sha AS "sourceCommitSha", source_archive_key AS "sourceArchiveKey",
				source_archive_sha256 AS "sourceArchiveSha256", target_path AS "targetPath",
				expected_generation AS "expectedGeneration", actor_type AS "actorType",
				actor_id AS "actorId", actor_name AS "actorName", actor_email AS "actorEmail",
				idempotency_key AS "idempotencyKey", result_generation AS "resultGeneration",
				result_commit_sha AS "resultCommitSha", result_archive_sha256 AS "resultArchiveSha256",
				result_object_key AS "resultObjectKey", result_sha256 AS "resultSha256",
				result_byte_size AS "resultByteSize", result_skipped_pdf_count AS "resultSkippedPdfCount",
				created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"
			FROM docx_conversion_job
			WHERE envelope_id = ${envelopeId} AND direction = ${direction} AND request_key = ${requestKey}`;

		return rows.length === 1 ? mapPostgresRowToJob(rows[0]) : null;
	}
}
