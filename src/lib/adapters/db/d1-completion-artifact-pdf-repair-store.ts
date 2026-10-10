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

const CLAIM_COLUMNS: string = `repair.envelope_id AS envelope_id,
	repair.attempts AS attempts,
	repair.locked_at AS locked_at,
	envelope.title AS envelope_title,
	envelope.sent_commit_sha AS sent_commit_sha,
	envelope.repository_archive_key AS repository_archive_key,
	envelope.repository_archive_sha256 AS repository_archive_sha256,
	envelope.field_generation AS field_generation,
	artifact.manifest_sha256 AS manifest_sha256,
	artifact.json_object_key AS json_object_key,
	artifact.json_sha256 AS json_sha256,
	artifact.markdown_object_key AS markdown_object_key,
	artifact.markdown_sha256 AS markdown_sha256,
	artifact.anchor_audit_event_id AS anchor_audit_event_id,
	artifact.audit_head_sequence AS audit_head_sequence,
	artifact.audit_head_event_hash AS audit_head_event_hash,
	artifact.audit_event_id AS audit_event_id,
	artifact.published_at AS published_at`;

const CLAIM_JOIN: string = `FROM completion_artifact_pdf_repair repair
	INNER JOIN envelope
		ON envelope.id = repair.envelope_id
	INNER JOIN completion_artifact artifact
		ON artifact.envelope_id = repair.envelope_id
	WHERE (
			(repair.status IN ('pending', 'failed') AND repair.retryable = 1 AND repair.available_at <= ?)
			OR (repair.status = 'processing' AND repair.locked_at < ?)
		)
		AND envelope.status = 'completed'
		AND NOT EXISTS (
			SELECT 1 FROM completion_artifact_pdf pdf
			WHERE pdf.envelope_id = repair.envelope_id
		)`;

interface ClaimRow {
	envelope_id: string;
	attempts: number;
	locked_at: string | null;
	envelope_title: string;
	sent_commit_sha: string | null;
	repository_archive_key: string | null;
	repository_archive_sha256: string | null;
	field_generation: number;
	manifest_sha256: string;
	json_object_key: string;
	json_sha256: string;
	markdown_object_key: string;
	markdown_sha256: string;
	anchor_audit_event_id: string;
	audit_head_sequence: number;
	audit_head_event_hash: string;
	audit_event_id: string;
	published_at: string;
}

interface RepairCommandRow {
	envelope_id: string;
	expected_manifest_sha256: string;
	pdf_object_key: string;
	pdf_sha256: string;
	pdf_byte_size: number;
	pdf_manifest_object_key: string;
	pdf_manifest_sha256: string;
}

export class D1CompletionArtifactPdfRepairStore implements CompletionArtifactPdfRepairStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async claimPendingPdfRepairs(
		command: ClaimCompletionArtifactPdfRepairsCommand
	): Promise<readonly ClaimedCompletionArtifactPdfRepair[]> {
		const discover: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO completion_artifact_pdf_repair (
					envelope_id, status, attempts, available_at, retryable,
					created_at, updated_at
				)
				SELECT artifact.envelope_id, 'pending', 0, ?, 1, ?, ?
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
				LIMIT ?
				ON CONFLICT (envelope_id) DO NOTHING`
			)
			.bind(command.claimedAt, command.claimedAt, command.claimedAt, command.discoveryLimit);
		const claim: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE completion_artifact_pdf_repair
				 SET status = 'processing', claim_token = ?, locked_at = ?, attempts = attempts + 1,
					updated_at = ?
				 WHERE rowid IN (
					SELECT repair.rowid
					${CLAIM_JOIN}
					ORDER BY repair.available_at ASC, repair.envelope_id ASC
					LIMIT ?
				 )
				 RETURNING envelope_id`
			)
			.bind(
				command.claimToken,
				command.claimedAt,
				command.claimedAt,
				command.claimedAt,
				command.staleBefore,
				command.claimLimit
			);
		const readClaim: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${CLAIM_COLUMNS}
				 FROM completion_artifact_pdf_repair repair
				 INNER JOIN envelope
					ON envelope.id = repair.envelope_id
				 INNER JOIN completion_artifact artifact
					ON artifact.envelope_id = repair.envelope_id
				 WHERE repair.status = 'processing' AND repair.claim_token = ?
				 ORDER BY repair.available_at ASC, repair.envelope_id ASC`
			)
			.bind(command.claimToken);
		const results: D1Result[] = await this.#database.batch([discover, claim, readClaim]);
		const rows: readonly ClaimRow[] = results[2].results as ClaimRow[];
		return rows.map(toClaimedRepair);
	}

	async readClaimedPdfRepair(
		command: ReadClaimedCompletionArtifactPdfRepairCommand
	): Promise<ClaimedCompletionArtifactPdfRepair | null> {
		const row: ClaimRow | null = await this.#database
			.prepare(
				`SELECT ${CLAIM_COLUMNS}
				 FROM completion_artifact_pdf_repair repair
				 INNER JOIN envelope
					ON envelope.id = repair.envelope_id
				 INNER JOIN completion_artifact artifact
					ON artifact.envelope_id = repair.envelope_id
				 WHERE repair.envelope_id = ?
					AND repair.status = 'processing' AND repair.claim_token = ?`
			)
			.bind(command.envelopeId, command.claimToken)
			.first<ClaimRow>();
		return row === null ? null : toClaimedRepair(row);
	}

	async completePdfRepair(
		command: CompleteCompletionArtifactPdfRepairCommand
	): Promise<CompleteCompletionArtifactPdfRepairResult> {
		const replay: CompleteCompletionArtifactPdfRepairResult | null =
			await this.#resolveCommand(command);
		if (replay !== null) return replay;
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO completion_artifact_pdf_repair_command (
					envelope_id, claim_token, expected_manifest_sha256,
					pdf_object_key, pdf_sha256, pdf_byte_size,
					pdf_manifest_object_key, pdf_manifest_sha256, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.envelopeId,
				command.claimToken,
				command.expectedManifestSha256,
				command.pdf.pdfObjectKey,
				command.pdf.pdfSha256,
				command.pdf.pdfByteSize,
				command.pdf.pdfManifestObjectKey,
				command.pdf.pdfManifestSha256,
				command.updatedAt
			);
		try {
			await this.#database.batch([statement]);
			return { outcome: 'repaired' };
		} catch (error: unknown) {
			const classified: CompleteCompletionArtifactPdfRepairResult | null =
				await this.#resolveCommand(command);
			if (classified !== null) return classified;
			if (!(await this.#leaseStillValid(command))) return { outcome: 'stale' };
			if (!(await this.#repairPredicatesSatisfied(command))) {
				return { outcome: 'integrity_error' };
			}
			throw error;
		}
	}

	async failPdfRepair(
		command: FailCompletionArtifactPdfRepairCommand
	): Promise<FailCompletionArtifactPdfRepairResult> {
		const result: D1Result = command.retryable
			? await this.#database
					.prepare(
						`UPDATE completion_artifact_pdf_repair
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 1,
							available_at = ?, last_error = ?, updated_at = ?
						 WHERE envelope_id = ? AND status = 'processing'
							AND claim_token = ?`
					)
					.bind(
						command.nextAvailableAt,
						command.errorCode,
						command.failedAt,
						command.envelopeId,
						command.claimToken
					)
					.run()
			: await this.#database
					.prepare(
						`UPDATE completion_artifact_pdf_repair
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 0,
							available_at = ?, last_error = ?, updated_at = ?
						 WHERE envelope_id = ? AND status = 'processing'
							AND claim_token = ?`
					)
					.bind(
						command.nextAvailableAt,
						command.errorCode,
						command.failedAt,
						command.envelopeId,
						command.claimToken
					)
					.run();
		return result.meta.changes === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}

	async requeueExhaustedPdfRepair(
		command: RequeueExhaustedCompletionArtifactPdfRepairCommand
	): Promise<RequeueExhaustedCompletionArtifactPdfRepairResult> {
		const replay: RequeueExhaustedCompletionArtifactPdfRepairResult | null =
			await this.#resolveRetry(command);
		if (replay !== null) return replay;
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO completion_artifact_pdf_repair_retry_command (
					envelope_id, idempotency_key, expected_attempts, expected_failed_at, requeued_at
				) VALUES (?, ?, ?, ?, ?)`
			)
			.bind(
				command.envelopeId,
				command.idempotencyKey,
				command.expectedAttempts,
				command.expectedFailedAt,
				command.requeuedAt
			);
		try {
			await this.#database.batch([statement]);
			return { outcome: 'requeued' };
		} catch (error: unknown) {
			const classified: RequeueExhaustedCompletionArtifactPdfRepairResult | null =
				await this.#resolveRetry(command);
			if (classified !== null) return classified;
			const envelope: { id: string } | null = await this.#database
				.prepare(`SELECT id FROM envelope WHERE id = ?`)
				.bind(command.envelopeId)
				.first<{ id: string }>();
			if (envelope === null) return { outcome: 'not_found' };
			if (!(await this.#retryEligible(command))) return { outcome: 'not_eligible' };
			throw error;
		}
	}

	async findPdfRepairStatus(
		envelopeId: string
	): Promise<CompletionArtifactPdfRepairStatusRow | null> {
		interface Row {
			envelope_id: string;
			status: CompletionArtifactPdfRepairStatusRow['status'];
			attempts: number;
			last_error: string | null;
			available_at: string;
			retryable: number;
			updated_at: string;
		}
		const row: Row | null = await this.#database
			.prepare(
				`SELECT envelope_id, status, attempts, last_error, available_at, retryable, updated_at
				 FROM completion_artifact_pdf_repair
				 WHERE envelope_id = ?`
			)
			.bind(envelopeId)
			.first<Row>();
		if (row === null) return null;
		return {
			envelopeId: row.envelope_id,
			status: row.status,
			attempts: row.attempts,
			lastError: row.last_error,
			availableAt: row.available_at,
			retryable: Number(row.retryable) === 1,
			updatedAt: row.updated_at
		};
	}

	async #resolveCommand(
		command: CompleteCompletionArtifactPdfRepairCommand
	): Promise<CompleteCompletionArtifactPdfRepairResult | null> {
		const row: RepairCommandRow | null = await this.#database
			.prepare(
				`SELECT envelope_id, expected_manifest_sha256, pdf_object_key, pdf_sha256,
					pdf_byte_size, pdf_manifest_object_key, pdf_manifest_sha256
				 FROM completion_artifact_pdf_repair_command
				 WHERE envelope_id = ?`
			)
			.bind(command.envelopeId)
			.first<RepairCommandRow>();
		if (row === null) return null;
		if (
			row.expected_manifest_sha256 !== command.expectedManifestSha256 ||
			row.pdf_object_key !== command.pdf.pdfObjectKey ||
			row.pdf_sha256 !== command.pdf.pdfSha256 ||
			Number(row.pdf_byte_size) !== command.pdf.pdfByteSize ||
			row.pdf_manifest_object_key !== command.pdf.pdfManifestObjectKey ||
			row.pdf_manifest_sha256 !== command.pdf.pdfManifestSha256
		) {
			return { outcome: 'integrity_error' };
		}
		return { outcome: 'replayed' };
	}

	async #leaseStillValid(command: CompleteCompletionArtifactPdfRepairCommand): Promise<boolean> {
		const row: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM completion_artifact_pdf_repair
				 WHERE envelope_id = ? AND status = 'processing' AND claim_token = ?`
			)
			.bind(command.envelopeId, command.claimToken)
			.first<{ ok: number }>();
		return row !== null;
	}

	async #repairPredicatesSatisfied(
		command: CompleteCompletionArtifactPdfRepairCommand
	): Promise<boolean> {
		const artifact: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM completion_artifact
				 WHERE envelope_id = ? AND manifest_sha256 = ?`
			)
			.bind(command.envelopeId, command.expectedManifestSha256)
			.first<{ ok: number }>();
		if (artifact === null) return false;
		const pdf: {
			pdf_object_key: string;
			pdf_sha256: string;
			pdf_byte_size: number | null;
			pdf_manifest_object_key: string;
			pdf_manifest_sha256: string;
		} | null = await this.#database
			.prepare(
				`SELECT pdf_object_key, pdf_sha256, pdf_byte_size, pdf_manifest_object_key, pdf_manifest_sha256
				 FROM completion_artifact_pdf
				 WHERE envelope_id = ?`
			)
			.bind(command.envelopeId)
			.first();
		if (pdf === null) return true;
		return (
			pdf.pdf_object_key === command.pdf.pdfObjectKey &&
			pdf.pdf_sha256 === command.pdf.pdfSha256 &&
			(pdf.pdf_byte_size === null || Number(pdf.pdf_byte_size) === command.pdf.pdfByteSize) &&
			pdf.pdf_manifest_object_key === command.pdf.pdfManifestObjectKey &&
			pdf.pdf_manifest_sha256 === command.pdf.pdfManifestSha256
		);
	}

	async #resolveRetry(
		command: RequeueExhaustedCompletionArtifactPdfRepairCommand
	): Promise<RequeueExhaustedCompletionArtifactPdfRepairResult | null> {
		const row: { expected_attempts: number; expected_failed_at: string } | null =
			await this.#database
				.prepare(
					`SELECT expected_attempts, expected_failed_at
					 FROM completion_artifact_pdf_repair_retry_command
					 WHERE envelope_id = ? AND idempotency_key = ?`
				)
				.bind(command.envelopeId, command.idempotencyKey)
				.first<{ expected_attempts: number; expected_failed_at: string }>();
		if (row === null) return null;
		if (
			Number(row.expected_attempts) !== command.expectedAttempts ||
			row.expected_failed_at !== command.expectedFailedAt
		) {
			return { outcome: 'conflict' };
		}
		return { outcome: 'replayed' };
	}

	async #retryEligible(
		command: RequeueExhaustedCompletionArtifactPdfRepairCommand
	): Promise<boolean> {
		const eligible: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM completion_artifact_pdf_repair
				 WHERE envelope_id = ? AND status = 'failed' AND retryable = 0
					AND claim_token IS NULL AND locked_at IS NULL
					AND attempts = ? AND updated_at = ? AND last_error = ?`
			)
			.bind(
				command.envelopeId,
				command.expectedAttempts,
				command.expectedFailedAt,
				EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR
			)
			.first<{ ok: number }>();
		return eligible !== null;
	}
}

function toClaimedRepair(row: ClaimRow): ClaimedCompletionArtifactPdfRepair {
	if (row.locked_at === null) {
		throw new Error('Claimed completion artifact PDF repair is missing its lease');
	}
	return {
		envelopeId: row.envelope_id,
		attempts: row.attempts,
		lockedAt: row.locked_at,
		envelopeTitle: row.envelope_title,
		sentCommitSha: row.sent_commit_sha,
		repositoryArchiveKey: row.repository_archive_key,
		repositoryArchiveSha256: row.repository_archive_sha256,
		fieldGeneration: row.field_generation,
		manifestSha256: row.manifest_sha256,
		jsonObjectKey: row.json_object_key,
		jsonSha256: row.json_sha256,
		markdownObjectKey: row.markdown_object_key,
		markdownSha256: row.markdown_sha256,
		anchorAuditEventId: row.anchor_audit_event_id,
		auditHeadSequence: Number(row.audit_head_sequence),
		auditHeadEventHash: row.audit_head_event_hash,
		auditEventId: row.audit_event_id,
		publishedAt: row.published_at
	};
}
