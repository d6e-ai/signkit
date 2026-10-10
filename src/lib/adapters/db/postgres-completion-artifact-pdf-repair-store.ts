import postgres from 'postgres';
import {
	EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR,
	type ClaimCompletionArtifactPdfRepairsCommand,
	type ClaimedCompletionArtifactPdfRepair,
	type CompleteCompletionArtifactPdfRepairCommand,
	type CompleteCompletionArtifactPdfRepairResult,
	type CompletionArtifactPdfRepairStatusRow,
	type CompletionArtifactPdfRepairStore,
	type FailCompletionArtifactPdfRepairCommand,
	type FailCompletionArtifactPdfRepairResult,
	type ReadClaimedCompletionArtifactPdfRepairCommand,
	type RequeueExhaustedCompletionArtifactPdfRepairCommand,
	type RequeueExhaustedCompletionArtifactPdfRepairResult
} from '$lib/ports/completion-artifact-pdf-repair-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

interface ClaimCandidateRow {
	envelopeId: string;
	attempts: number | string;
	lockedAt: Date | string | null;
	envelopeTitle: string;
	sentCommitSha: string | null;
	repositoryArchiveKey: string | null;
	repositoryArchiveSha256: string | null;
	fieldGeneration: number;
	manifestSha256: string;
	jsonObjectKey: string;
	jsonSha256: string;
	markdownObjectKey: string;
	markdownSha256: string;
	anchorAuditEventId: string;
	auditHeadSequence: number | string;
	auditHeadEventHash: string;
	auditEventId: string;
	publishedAt: Date | string;
}

interface RepairCommandRow {
	envelopeId: string;
	expectedManifestSha256: string;
	pdfObjectKey: string;
	pdfSha256: string;
	pdfByteSize: number | string;
	pdfManifestObjectKey: string;
	pdfManifestSha256: string;
}

interface RepairLockRow {
	status: string;
	claimToken: string | null;
}

export class PostgresCompletionArtifactPdfRepairStore implements CompletionArtifactPdfRepairStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async claimPendingPdfRepairs(
		command: ClaimCompletionArtifactPdfRepairsCommand
	): Promise<readonly ClaimedCompletionArtifactPdfRepair[]> {
		return await this.#sql.begin(
			async (transaction): Promise<readonly ClaimedCompletionArtifactPdfRepair[]> => {
				await transaction`
					INSERT INTO completion_artifact_pdf_repair (
						envelope_id, status, attempts, available_at, retryable,
						created_at, updated_at
					)
					SELECT artifact.envelope_id, 'pending', 0,
						${command.claimedAt}::timestamptz, true,
						${command.claimedAt}::timestamptz, ${command.claimedAt}::timestamptz
					FROM completion_artifact artifact
					INNER JOIN envelope
						ON envelope.id = artifact.envelope_id
					WHERE envelope.status = 'completed'
						AND NOT EXISTS (
							SELECT 1 FROM completion_artifact_pdf pdf
							WHERE pdf.envelope_id = artifact.envelope_id
						)
						AND NOT EXISTS (
							SELECT 1 FROM completion_artifact_pdf_repair repair
							WHERE repair.envelope_id = artifact.envelope_id
						)
					ORDER BY artifact.published_at ASC, artifact.envelope_id ASC
					LIMIT ${command.discoveryLimit}
					ON CONFLICT (envelope_id) DO NOTHING`;

				const candidates = await transaction<ClaimCandidateRow[]>`
					SELECT repair.envelope_id AS "envelopeId",
						repair.attempts AS attempts, repair.locked_at AS "lockedAt",
						envelope.title AS "envelopeTitle",
						envelope.sent_commit_sha AS "sentCommitSha",
						envelope.repository_archive_key AS "repositoryArchiveKey",
						envelope.repository_archive_sha256 AS "repositoryArchiveSha256",
						envelope.field_generation AS "fieldGeneration",
						artifact.manifest_sha256 AS "manifestSha256",
						artifact.json_object_key AS "jsonObjectKey",
						artifact.json_sha256 AS "jsonSha256",
						artifact.markdown_object_key AS "markdownObjectKey",
						artifact.markdown_sha256 AS "markdownSha256",
						artifact.anchor_audit_event_id AS "anchorAuditEventId",
						artifact.audit_head_sequence AS "auditHeadSequence",
						artifact.audit_head_event_hash AS "auditHeadEventHash",
						artifact.audit_event_id AS "auditEventId",
						artifact.published_at AS "publishedAt"
					FROM completion_artifact_pdf_repair repair
					INNER JOIN envelope
						ON envelope.id = repair.envelope_id
					INNER JOIN completion_artifact artifact
						ON artifact.envelope_id = repair.envelope_id
					WHERE (
							(repair.status IN ('pending', 'failed') AND repair.retryable
								AND repair.available_at <= ${command.claimedAt}::timestamptz)
							OR (repair.status = 'processing'
								AND repair.locked_at < ${command.staleBefore}::timestamptz)
						)
						AND envelope.status = 'completed'
						AND NOT EXISTS (
							SELECT 1 FROM completion_artifact_pdf pdf
							WHERE pdf.envelope_id = repair.envelope_id
						)
					ORDER BY repair.available_at ASC, repair.envelope_id ASC
					LIMIT ${command.claimLimit}
					FOR UPDATE OF repair SKIP LOCKED`;
				if (candidates.length === 0) return [];

				const claimed: ClaimedCompletionArtifactPdfRepair[] = [];
				for (const row of candidates) {
					const updated = await transaction<{ envelope_id: string }[]>`
						UPDATE completion_artifact_pdf_repair
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}::timestamptz, attempts = attempts + 1,
							updated_at = ${command.claimedAt}::timestamptz
						WHERE envelope_id = ${row.envelopeId}
							AND (
								(status IN ('pending', 'failed') AND retryable
									AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing'
									AND locked_at < ${command.staleBefore}::timestamptz)
							)
						RETURNING envelope_id`;
					if (updated.length === 1) {
						claimed.push(toClaimedRepair(row, command.claimedAt, 1));
					}
				}
				return claimed;
			}
		);
	}

	async readClaimedPdfRepair(
		command: ReadClaimedCompletionArtifactPdfRepairCommand
	): Promise<ClaimedCompletionArtifactPdfRepair | null> {
		const rows = await this.#sql<ClaimCandidateRow[]>`
			SELECT repair.envelope_id AS "envelopeId",
				repair.attempts AS attempts, repair.locked_at AS "lockedAt",
				envelope.title AS "envelopeTitle",
				envelope.sent_commit_sha AS "sentCommitSha",
				envelope.repository_archive_key AS "repositoryArchiveKey",
				envelope.repository_archive_sha256 AS "repositoryArchiveSha256",
				envelope.field_generation AS "fieldGeneration",
				artifact.manifest_sha256 AS "manifestSha256",
				artifact.json_object_key AS "jsonObjectKey",
				artifact.json_sha256 AS "jsonSha256",
				artifact.markdown_object_key AS "markdownObjectKey",
				artifact.markdown_sha256 AS "markdownSha256",
				artifact.anchor_audit_event_id AS "anchorAuditEventId",
				artifact.audit_head_sequence AS "auditHeadSequence",
				artifact.audit_head_event_hash AS "auditHeadEventHash",
				artifact.audit_event_id AS "auditEventId",
				artifact.published_at AS "publishedAt"
			FROM completion_artifact_pdf_repair repair
			INNER JOIN envelope
				ON envelope.id = repair.envelope_id
			INNER JOIN completion_artifact artifact
				ON artifact.envelope_id = repair.envelope_id
			WHERE repair.envelope_id = ${command.envelopeId}
				AND repair.status = 'processing' AND repair.claim_token = ${command.claimToken}`;
		const row: ClaimCandidateRow | undefined = rows[0];
		if (row === undefined || row.lockedAt === null) return null;
		return toClaimedRepair(row, isoTimestamp(row.lockedAt), 0);
	}

	async completePdfRepair(
		command: CompleteCompletionArtifactPdfRepairCommand
	): Promise<CompleteCompletionArtifactPdfRepairResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<CompleteCompletionArtifactPdfRepairResult> => {
					const replay: CompleteCompletionArtifactPdfRepairResult | null =
						await this.#resolveCommand(transaction, command);
					if (replay !== null) return replay;

					const repairRows = await transaction<RepairLockRow[]>`
						SELECT status, claim_token AS "claimToken"
						FROM completion_artifact_pdf_repair
						WHERE envelope_id = ${command.envelopeId}
						FOR UPDATE`;
					const repair: RepairLockRow | undefined = repairRows[0];
					if (
						repair === undefined ||
						repair.status !== 'processing' ||
						repair.claimToken !== command.claimToken
					) {
						return { outcome: 'stale' };
					}

					const artifactRows = await transaction<{ manifestSha256: string }[]>`
						SELECT manifest_sha256 AS "manifestSha256"
						FROM completion_artifact
						WHERE envelope_id = ${command.envelopeId}
						FOR UPDATE`;
					const artifact: { manifestSha256: string } | undefined = artifactRows[0];
					if (
						artifact === undefined ||
						artifact.manifestSha256 !== command.expectedManifestSha256
					) {
						return { outcome: 'integrity_error' };
					}

					await transaction`
						INSERT INTO completion_artifact_pdf (
							envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
							pdf_manifest_object_key, pdf_manifest_sha256, published_at
						) VALUES (
							${command.envelopeId}, ${command.pdf.pdfObjectKey}, ${command.pdf.pdfSha256},
							${command.pdf.pdfByteSize}, ${command.pdf.pdfManifestObjectKey},
							${command.pdf.pdfManifestSha256}, ${command.updatedAt}::timestamptz
						)
						ON CONFLICT (envelope_id) DO NOTHING`;

					const pdfRows = await transaction<
						{
							pdfObjectKey: string;
							pdfSha256: string;
							pdfByteSize: number | string | null;
							pdfManifestObjectKey: string;
							pdfManifestSha256: string;
						}[]
					>`
						SELECT pdf_object_key AS "pdfObjectKey", pdf_sha256 AS "pdfSha256",
							pdf_byte_size AS "pdfByteSize",
							pdf_manifest_object_key AS "pdfManifestObjectKey",
							pdf_manifest_sha256 AS "pdfManifestSha256"
						FROM completion_artifact_pdf
						WHERE envelope_id = ${command.envelopeId}`;
					const pdf = pdfRows[0];
					if (
						pdf === undefined ||
						pdf.pdfObjectKey !== command.pdf.pdfObjectKey ||
						pdf.pdfSha256 !== command.pdf.pdfSha256 ||
						(pdf.pdfByteSize !== null && Number(pdf.pdfByteSize) !== command.pdf.pdfByteSize) ||
						pdf.pdfManifestObjectKey !== command.pdf.pdfManifestObjectKey ||
						pdf.pdfManifestSha256 !== command.pdf.pdfManifestSha256
					) {
						return { outcome: 'integrity_error' };
					}

					const updated = await transaction<{ envelope_id: string }[]>`
						UPDATE completion_artifact_pdf_repair
						SET status = 'repaired', claim_token = NULL, locked_at = NULL, retryable = false,
							last_error = NULL, updated_at = ${command.updatedAt}::timestamptz
						WHERE envelope_id = ${command.envelopeId}
							AND status = 'processing' AND claim_token = ${command.claimToken}
						RETURNING envelope_id`;
					if (updated.length !== 1) return { outcome: 'stale' };

					await transaction`
						INSERT INTO completion_artifact_pdf_repair_command (
							envelope_id, claim_token, expected_manifest_sha256,
							pdf_object_key, pdf_sha256, pdf_byte_size,
							pdf_manifest_object_key, pdf_manifest_sha256, updated_at
						) VALUES (
							${command.envelopeId}, ${command.claimToken}, ${command.expectedManifestSha256},
							${command.pdf.pdfObjectKey}, ${command.pdf.pdfSha256}, ${command.pdf.pdfByteSize},
							${command.pdf.pdfManifestObjectKey}, ${command.pdf.pdfManifestSha256},
							${command.updatedAt}::timestamptz
						)`;
					return { outcome: 'repaired' };
				}
			);
		} catch (error: unknown) {
			const classified: CompleteCompletionArtifactPdfRepairResult | null =
				await this.#resolveCommand(this.#sql, command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async failPdfRepair(
		command: FailCompletionArtifactPdfRepairCommand
	): Promise<FailCompletionArtifactPdfRepairResult> {
		const rows = command.retryable
			? await this.#sql<{ envelope_id: string }[]>`
					UPDATE completion_artifact_pdf_repair
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = true,
						available_at = ${command.nextAvailableAt}::timestamptz,
						last_error = ${command.errorCode},
						updated_at = ${command.failedAt}::timestamptz
					WHERE envelope_id = ${command.envelopeId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING envelope_id`
			: await this.#sql<{ envelope_id: string }[]>`
					UPDATE completion_artifact_pdf_repair
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
						available_at = ${command.nextAvailableAt}::timestamptz,
						last_error = ${command.errorCode},
						updated_at = ${command.failedAt}::timestamptz
					WHERE envelope_id = ${command.envelopeId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING envelope_id`;
		return rows.length === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}

	async requeueExhaustedPdfRepair(
		command: RequeueExhaustedCompletionArtifactPdfRepairCommand
	): Promise<RequeueExhaustedCompletionArtifactPdfRepairResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<RequeueExhaustedCompletionArtifactPdfRepairResult> => {
					// Lock first, then read the receipt: a concurrent duplicate that
					// waited on this lock must observe the winner's committed receipt
					// and replay, rather than fail the already-consumed CAS.
					const envelopeRows = await transaction<{ id: string }[]>`
						SELECT id FROM envelope WHERE id = ${command.envelopeId} FOR UPDATE`;
					if (envelopeRows.length === 0) return { outcome: 'not_found' };
					const replay: RequeueExhaustedCompletionArtifactPdfRepairResult | null =
						await this.#resolveRetry(transaction, command);
					if (replay !== null) return replay;
					await transaction<{ envelope_id: string }[]>`
						SELECT envelope_id FROM completion_artifact_pdf_repair
						WHERE envelope_id = ${command.envelopeId}
						FOR UPDATE`;
					const updated = await transaction<{ envelope_id: string }[]>`
						UPDATE completion_artifact_pdf_repair
						SET status = 'pending', retryable = true, attempts = 0, last_error = NULL,
							claim_token = NULL, locked_at = NULL,
							available_at = ${command.requeuedAt}::timestamptz,
							updated_at = ${command.requeuedAt}::timestamptz
						WHERE envelope_id = ${command.envelopeId}
							AND status = 'failed' AND NOT retryable
							AND claim_token IS NULL AND locked_at IS NULL
							AND attempts = ${command.expectedAttempts}
							AND updated_at = ${command.expectedFailedAt}::timestamptz
							AND last_error = ${EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR}
						RETURNING envelope_id`;
					if (updated.length !== 1) return { outcome: 'not_eligible' };
					await transaction`
						INSERT INTO completion_artifact_pdf_repair_retry_command (
							envelope_id, idempotency_key, expected_attempts, expected_failed_at,
							requeued_at
						) VALUES (
							${command.envelopeId}, ${command.idempotencyKey},
							${command.expectedAttempts}, ${command.expectedFailedAt}::timestamptz,
							${command.requeuedAt}::timestamptz
						)`;
					return { outcome: 'requeued' };
				}
			);
		} catch (error: unknown) {
			const classified: RequeueExhaustedCompletionArtifactPdfRepairResult | null =
				await this.#resolveRetry(this.#sql, command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async findPdfRepairStatus(
		envelopeId: string
	): Promise<CompletionArtifactPdfRepairStatusRow | null> {
		const rows = await this.#sql<
			{
				envelopeId: string;
				status: CompletionArtifactPdfRepairStatusRow['status'];
				attempts: number | string;
				lastError: string | null;
				availableAt: Date | string;
				retryable: boolean;
				updatedAt: string;
			}[]
		>`
			SELECT envelope_id AS "envelopeId", status, attempts,
				last_error AS "lastError", available_at AS "availableAt", retryable,
				to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
			FROM completion_artifact_pdf_repair
			WHERE envelope_id = ${envelopeId}`;
		const row = rows[0];
		if (row === undefined) return null;
		return {
			envelopeId: row.envelopeId,
			status: row.status,
			attempts: Number(row.attempts),
			lastError: row.lastError,
			availableAt: isoTimestamp(row.availableAt),
			retryable: row.retryable,
			// Microsecond text, not a millisecond Date: the requeue CAS compares it exactly.
			updatedAt: row.updatedAt
		};
	}

	async #resolveCommand(
		sql: Sql,
		command: CompleteCompletionArtifactPdfRepairCommand
	): Promise<CompleteCompletionArtifactPdfRepairResult | null> {
		const rows = await sql<RepairCommandRow[]>`
			SELECT envelope_id AS "envelopeId",
				expected_manifest_sha256 AS "expectedManifestSha256",
				pdf_object_key AS "pdfObjectKey", pdf_sha256 AS "pdfSha256",
				pdf_byte_size AS "pdfByteSize",
				pdf_manifest_object_key AS "pdfManifestObjectKey",
				pdf_manifest_sha256 AS "pdfManifestSha256"
			FROM completion_artifact_pdf_repair_command
			WHERE envelope_id = ${command.envelopeId}`;
		const row: RepairCommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (
			row.expectedManifestSha256 !== command.expectedManifestSha256 ||
			row.pdfObjectKey !== command.pdf.pdfObjectKey ||
			row.pdfSha256 !== command.pdf.pdfSha256 ||
			Number(row.pdfByteSize) !== command.pdf.pdfByteSize ||
			row.pdfManifestObjectKey !== command.pdf.pdfManifestObjectKey ||
			row.pdfManifestSha256 !== command.pdf.pdfManifestSha256
		) {
			return { outcome: 'integrity_error' };
		}
		return { outcome: 'replayed' };
	}

	async #resolveRetry(
		sql: Sql,
		command: RequeueExhaustedCompletionArtifactPdfRepairCommand
	): Promise<RequeueExhaustedCompletionArtifactPdfRepairResult | null> {
		const rows = await sql<{ expectedAttempts: number | string; sameGeneration: boolean }[]>`
			SELECT expected_attempts AS "expectedAttempts",
				expected_failed_at = ${command.expectedFailedAt}::timestamptz AS "sameGeneration"
			FROM completion_artifact_pdf_repair_retry_command
			WHERE envelope_id = ${command.envelopeId}
				AND idempotency_key = ${command.idempotencyKey}`;
		const row: { expectedAttempts: number | string; sameGeneration: boolean } | undefined = rows[0];
		if (row === undefined) return null;
		if (Number(row.expectedAttempts) !== command.expectedAttempts || !row.sameGeneration) {
			return { outcome: 'conflict' };
		}
		return { outcome: 'replayed' };
	}
}

function toClaimedRepair(
	row: ClaimCandidateRow,
	lockedAt: string,
	attemptIncrement: number
): ClaimedCompletionArtifactPdfRepair {
	return {
		envelopeId: row.envelopeId,
		attempts: Number(row.attempts) + attemptIncrement,
		lockedAt,
		envelopeTitle: row.envelopeTitle,
		sentCommitSha: row.sentCommitSha,
		repositoryArchiveKey: row.repositoryArchiveKey,
		repositoryArchiveSha256: row.repositoryArchiveSha256,
		fieldGeneration: row.fieldGeneration,
		manifestSha256: row.manifestSha256,
		jsonObjectKey: row.jsonObjectKey,
		jsonSha256: row.jsonSha256,
		markdownObjectKey: row.markdownObjectKey,
		markdownSha256: row.markdownSha256,
		anchorAuditEventId: row.anchorAuditEventId,
		auditHeadSequence: Number(row.auditHeadSequence),
		auditHeadEventHash: row.auditHeadEventHash,
		auditEventId: row.auditEventId,
		publishedAt: isoTimestamp(row.publishedAt)
	};
}

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
