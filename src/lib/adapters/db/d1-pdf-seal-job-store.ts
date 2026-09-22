import {
	assertPdfSealAttemptCommand,
	assertPdfSealErrorCode,
	assertPdfSealProviderReceipt,
	assertValidPdfSealArtifact,
	assertValidPdfSealFrozenReference,
	assertValidPdfSealValidationEvidence,
	boundPdfSealClaimLimit,
	pdfSealProviderPollAvailableAt,
	pdfSealRetryAvailableAt,
	PDF_SEAL_JOB_MAX_ATTEMPTS,
	type ClaimPdfSealJobsCommand,
	type ClaimedPdfSealJob,
	type CompletePdfSealJobCommand,
	type DeferPdfSealProviderCommand,
	type EnqueuePdfSealJobCommand,
	type EnqueuePdfSealJobResult,
	type FailPdfSealJobCommand,
	type PdfSealJob,
	type PdfSealJobAction,
	type PdfSealJobStatus,
	type PdfSealJobStore,
	type PdfSealCheckpointCommand,
	type PdfSealSealedArtifact,
	type PdfSealValidationEvidence,
	type RecordAmbiguousPdfSealSubmitCommand,
	type RecordPdfSealProviderReceiptCommand,
	type RecordPdfSealProviderResultCommand
} from '$lib/ports/pdf-seal-job-store';
import type { PdfSealProfile } from '$lib/ports/pdf-seal-provider';
import type { PdfSealValidationChecks } from '$lib/ports/pdf-seal-validator';

interface D1PdfSealJobRow {
	id: string;
	envelope_id: string;
	operation_id: string;
	validation_id: string;
	status: PdfSealJobStatus;
	next_action: PdfSealJobAction;
	attempts: number;
	available_at: string;
	locked_at: string | null;
	retryable: number | null;
	last_error_code: string | null;
	source_object_key: string;
	source_sha256: string;
	source_byte_size: number;
	requested_profile: PdfSealProfile;
	signer_certificate_sha256: string;
	seal_policy_id: string;
	validation_policy_id: string;
	tsa_policy_id: string | null;
	tsa_trust_bundle_sha256: string | null;
	provider_receipt_id: string | null;
	sealed_object_key: string | null;
	sealed_sha256: string | null;
	sealed_byte_size: number | null;
	achieved_profile: PdfSealProfile | null;
	validator_receipt_id: string | null;
	validation_checks_json: string | null;
	validation_report_object_key: string | null;
	validation_report_sha256: string | null;
	validation_report_byte_size: number | null;
	validated_at: string | null;
	created_at: string;
	updated_at: string;
	ready_at: string | null;
	failed_at: string | null;
}

const JOB_COLUMNS: string = `id, envelope_id, operation_id, validation_id, status, next_action,
	attempts, available_at, locked_at, retryable, last_error_code,
	source_object_key, source_sha256, source_byte_size, requested_profile,
	signer_certificate_sha256, seal_policy_id, validation_policy_id,
	tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id,
	sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile,
	validator_receipt_id, validation_checks_json, validation_report_object_key,
	validation_report_sha256, validation_report_byte_size, validated_at,
	created_at, updated_at, ready_at, failed_at`;

export class D1PdfSealJobStore implements PdfSealJobStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async enqueue(command: EnqueuePdfSealJobCommand): Promise<EnqueuePdfSealJobResult> {
		assertValidPdfSealFrozenReference(command);
		assertTimestamp(command.createdAt, 'createdAt');
		const inserted: D1Result = await this.#database
			.prepare(
				`INSERT INTO pdf_seal_job (
					id, envelope_id, operation_id, validation_id, status, next_action,
					claim_token, attempts, available_at, locked_at, retryable, last_error_code,
					source_object_key, source_sha256, source_byte_size, requested_profile,
					signer_certificate_sha256, seal_policy_id, validation_policy_id,
					tsa_policy_id, tsa_trust_bundle_sha256, created_at, updated_at
				)
				SELECT ?, pdf.envelope_id, ?, ?, 'pending', 'submit',
					NULL, 0, ?, NULL, NULL, NULL,
					?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				FROM completion_artifact_pdf AS pdf
				WHERE pdf.envelope_id = ? AND pdf.pdf_object_key = ? AND pdf.pdf_sha256 = ?
				ON CONFLICT DO NOTHING`
			)
			.bind(
				command.jobId,
				command.operationId,
				command.validationId,
				command.createdAt,
				command.sourceObjectKey,
				command.sourceSha256,
				command.sourceByteSize,
				command.requestedProfile,
				command.signerCertificateSha256,
				command.sealPolicyId,
				command.validationPolicyId,
				command.tsaPolicyId,
				command.tsaTrustBundleSha256,
				command.createdAt,
				command.createdAt,
				command.envelopeId,
				command.sourceObjectKey,
				command.sourceSha256
			)
			.run();

		if ((inserted.meta.changes ?? 0) === 1) {
			const job: PdfSealJob | null = await this.find(command.jobId);
			if (job === null) throw new Error('PDF seal job disappeared after enqueue');
			return { outcome: 'enqueued', job };
		}

		const existing: PdfSealJob | null = await this.findByEnvelopeId(command.envelopeId);
		if (existing !== null) {
			return sameFrozenReference(existing, command)
				? { outcome: 'existing', job: existing }
				: { outcome: 'conflict' };
		}
		const exactSource: { envelope_id: string } | null = await this.#database
			.prepare(
				`SELECT envelope_id FROM completion_artifact_pdf
				 WHERE envelope_id = ? AND pdf_object_key = ? AND pdf_sha256 = ?`
			)
			.bind(command.envelopeId, command.sourceObjectKey, command.sourceSha256)
			.first<{ envelope_id: string }>();
		return exactSource === null ? { outcome: 'source_mismatch' } : { outcome: 'conflict' };
	}

	async claim(command: ClaimPdfSealJobsCommand): Promise<readonly ClaimedPdfSealJob[]> {
		assertClaimCommand(command);
		const limit: number = boundPdfSealClaimLimit(command.limit);
		const jobPredicate: string = command.jobId === undefined ? '' : 'AND id = ?';
		const limitValue: number = command.jobId === undefined ? limit : 1;
		const bindings: unknown[] = [
			command.claimToken,
			command.claimedAt,
			command.claimedAt,
			command.claimedAt,
			command.claimedAt,
			command.staleBefore
		];
		if (command.jobId !== undefined) bindings.push(command.jobId);
		bindings.push(limitValue);

		const claim: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE pdf_seal_job
				 SET status = 'processing', claim_token = ?, locked_at = ?,
					attempts = CASE WHEN status = 'processing' THEN attempts ELSE attempts + 1 END,
					retryable = NULL, last_error_code = NULL,
					failed_at = NULL, updated_at = ?
				 WHERE id IN (
					SELECT id FROM pdf_seal_job
					WHERE next_action <> 'publish'
					AND (
						(status = 'pending' AND attempts < ${PDF_SEAL_JOB_MAX_ATTEMPTS} AND available_at <= ?)
						OR (status = 'failed' AND attempts < ${PDF_SEAL_JOB_MAX_ATTEMPTS}
							AND retryable = 1 AND available_at <= ?)
						OR (status = 'processing' AND attempts BETWEEN 1 AND ${PDF_SEAL_JOB_MAX_ATTEMPTS}
							AND locked_at < ?)
					)
					${jobPredicate}
					ORDER BY available_at ASC, created_at ASC, id ASC
					LIMIT ?
				 )`
			)
			.bind(...bindings);
		const read: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${JOB_COLUMNS} FROM pdf_seal_job
				 WHERE status = 'processing' AND claim_token = ? AND locked_at = ?
				 ORDER BY available_at ASC, created_at ASC, id ASC`
			)
			.bind(command.claimToken, command.claimedAt);
		const results: D1Result[] = await this.#database.batch([claim, read]);
		const rows: readonly D1PdfSealJobRow[] = (results[1]?.results ??
			[]) as unknown as D1PdfSealJobRow[];
		return rows.map((row: D1PdfSealJobRow): ClaimedPdfSealJob => ({
			job: mapRow(row),
			claimToken: command.claimToken,
			startedAt: command.claimedAt
		}));
	}

	async checkpoint(command: PdfSealCheckpointCommand): Promise<boolean> {
		switch (command.kind) {
			case 'ambiguous_submit':
				return this.#recordAmbiguousSubmit(command);
			case 'provider_receipt':
				return this.#recordProviderReceipt(command);
			case 'provider_pending':
				return this.#deferProvider(command);
			case 'provider_result':
				return this.#recordProviderResult(command);
		}
	}

	async #recordAmbiguousSubmit(command: RecordAmbiguousPdfSealSubmitCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		return this.#transition(
			command,
			`INSERT INTO pdf_seal_attempt (
				id, job_id, attempt_number, action, outcome, error_code,
				provider_receipt_id, validator_receipt_id, sealed_sha256, started_at, finished_at
			 ) SELECT ?, id, ?, next_action, 'ambiguous', NULL, NULL, NULL, NULL, ?, ?
			 FROM pdf_seal_job
			 WHERE id = ? AND status = 'processing' AND next_action = 'submit'
				AND claim_token = ? AND attempts = ?`,
			[
				command.attemptId,
				command.attemptNumber,
				command.startedAt,
				command.finishedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			],
			`UPDATE pdf_seal_job
			 SET status = 'pending', next_action = 'recover_submit', claim_token = NULL,
				locked_at = NULL, available_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND next_action = 'submit'
				AND claim_token = ? AND attempts = ?`,
			[
				command.finishedAt,
				command.finishedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			]
		);
	}

	async #recordProviderReceipt(command: RecordPdfSealProviderReceiptCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		return this.#transition(
			command,
			`INSERT INTO pdf_seal_attempt (
				id, job_id, attempt_number, action, outcome, error_code,
				provider_receipt_id, validator_receipt_id, sealed_sha256, started_at, finished_at
			 ) SELECT ?, id, ?, next_action, 'checkpointed', NULL, ?, NULL, NULL, ?, ?
			 FROM pdf_seal_job
			 WHERE id = ? AND status = 'processing' AND next_action IN ('submit','recover_submit')
				AND provider_receipt_id IS NULL AND claim_token = ? AND attempts = ?`,
			[
				command.attemptId,
				command.attemptNumber,
				command.providerReceiptId,
				command.startedAt,
				command.finishedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			],
			`UPDATE pdf_seal_job
			 SET status = 'pending', next_action = 'poll_provider', claim_token = NULL,
				locked_at = NULL, provider_receipt_id = ?, available_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND next_action IN ('submit','recover_submit')
				AND provider_receipt_id IS NULL AND claim_token = ? AND attempts = ?`,
			[
				command.providerReceiptId,
				command.finishedAt,
				command.finishedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			]
		);
	}

	async #deferProvider(command: DeferPdfSealProviderCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		const availableAt: string = pdfSealProviderPollAvailableAt(command.finishedAt);
		return this.#transition(
			command,
			`INSERT INTO pdf_seal_attempt (
				id, job_id, attempt_number, action, outcome, error_code,
				provider_receipt_id, validator_receipt_id, sealed_sha256, started_at, finished_at
			 ) SELECT ?, id, ?, next_action, 'deferred', NULL, ?, NULL, NULL, ?, ?
			 FROM pdf_seal_job
			 WHERE id = ? AND status = 'processing' AND next_action = 'poll_provider'
				AND provider_receipt_id = ? AND claim_token = ? AND attempts = ?`,
			[
				command.attemptId,
				command.attemptNumber,
				command.providerReceiptId,
				command.startedAt,
				command.finishedAt,
				command.jobId,
				command.providerReceiptId,
				command.claimToken,
				command.attemptNumber
			],
			`UPDATE pdf_seal_job
			 SET status = 'pending', claim_token = NULL, locked_at = NULL,
				available_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND next_action = 'poll_provider'
				AND provider_receipt_id = ? AND claim_token = ? AND attempts = ?`,
			[
				availableAt,
				command.finishedAt,
				command.jobId,
				command.providerReceiptId,
				command.claimToken,
				command.attemptNumber
			]
		);
	}

	async #recordProviderResult(command: RecordPdfSealProviderResultCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		const job: PdfSealJob | null = await this.find(command.jobId);
		if (job === null) return false;
		assertValidPdfSealArtifact(command.sealedArtifact, job.sourceByteSize, job.requestedProfile);
		return this.#transition(
			command,
			`INSERT INTO pdf_seal_attempt (
				id, job_id, attempt_number, action, outcome, error_code,
				provider_receipt_id, validator_receipt_id, sealed_sha256, started_at, finished_at
			 ) SELECT ?, id, ?, next_action, 'checkpointed', NULL, ?, NULL, ?, ?, ?
			 FROM pdf_seal_job
			 WHERE id = ? AND status = 'processing' AND next_action = 'poll_provider'
				AND provider_receipt_id = ? AND claim_token = ? AND attempts = ?`,
			[
				command.attemptId,
				command.attemptNumber,
				command.providerReceiptId,
				command.sealedArtifact.sha256,
				command.startedAt,
				command.finishedAt,
				command.jobId,
				command.providerReceiptId,
				command.claimToken,
				command.attemptNumber
			],
			`UPDATE pdf_seal_job
			 SET status = 'pending', next_action = 'validate', claim_token = NULL, locked_at = NULL,
				sealed_object_key = ?, sealed_sha256 = ?, sealed_byte_size = ?, achieved_profile = ?,
				available_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND next_action = 'poll_provider'
				AND provider_receipt_id = ? AND claim_token = ? AND attempts = ?`,
			[
				command.sealedArtifact.objectKey,
				command.sealedArtifact.sha256,
				command.sealedArtifact.byteSize,
				command.sealedArtifact.achievedProfile,
				command.finishedAt,
				command.finishedAt,
				command.jobId,
				command.providerReceiptId,
				command.claimToken,
				command.attemptNumber
			]
		);
	}

	async complete(command: CompletePdfSealJobCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		const job: PdfSealJob | null = await this.find(command.jobId);
		if (job === null) return false;
		assertValidPdfSealArtifact(command.sealedArtifact, job.sourceByteSize, job.requestedProfile);
		assertValidPdfSealValidationEvidence(command.validationEvidence, job.requestedProfile);
		const checksJson: string = JSON.stringify(command.validationEvidence.checks);
		return this.#transition(
			command,
			`INSERT INTO pdf_seal_attempt (
				id, job_id, attempt_number, action, outcome, error_code,
				provider_receipt_id, validator_receipt_id, sealed_sha256, started_at, finished_at
			 ) SELECT ?, id, ?, next_action, 'publication_ready', NULL, ?, ?, ?, ?, ?
			 FROM pdf_seal_job
			 WHERE id = ? AND status = 'processing' AND next_action = 'validate'
				AND provider_receipt_id = ? AND sealed_object_key = ? AND sealed_sha256 = ?
				AND sealed_byte_size = ? AND achieved_profile = ?
				AND claim_token = ? AND attempts = ?`,
			[
				command.attemptId,
				command.attemptNumber,
				command.providerReceiptId,
				command.validationEvidence.validatorReceiptId,
				command.sealedArtifact.sha256,
				command.startedAt,
				command.finishedAt,
				command.jobId,
				command.providerReceiptId,
				command.sealedArtifact.objectKey,
				command.sealedArtifact.sha256,
				command.sealedArtifact.byteSize,
				command.sealedArtifact.achievedProfile,
				command.claimToken,
				command.attemptNumber
			],
			`UPDATE pdf_seal_job
			 SET status = 'publication_ready', next_action = 'publish', claim_token = NULL,
				locked_at = NULL, validator_receipt_id = ?, validation_checks_json = ?,
				validation_report_object_key = ?, validation_report_sha256 = ?,
				validation_report_byte_size = ?, validated_at = ?, ready_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND next_action = 'validate'
				AND provider_receipt_id = ? AND sealed_object_key = ? AND sealed_sha256 = ?
				AND sealed_byte_size = ? AND achieved_profile = ?
				AND claim_token = ? AND attempts = ?`,
			[
				command.validationEvidence.validatorReceiptId,
				checksJson,
				command.validationEvidence.reportObjectKey,
				command.validationEvidence.reportSha256,
				command.validationEvidence.reportByteSize,
				command.validationEvidence.validatedAt,
				command.finishedAt,
				command.finishedAt,
				command.jobId,
				command.providerReceiptId,
				command.sealedArtifact.objectKey,
				command.sealedArtifact.sha256,
				command.sealedArtifact.byteSize,
				command.sealedArtifact.achievedProfile,
				command.claimToken,
				command.attemptNumber
			]
		);
	}

	async fail(command: FailPdfSealJobCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealErrorCode(command.errorCode);
		const retryable: boolean =
			command.retryable && command.attemptNumber < PDF_SEAL_JOB_MAX_ATTEMPTS;
		const availableAt: string = retryable
			? pdfSealRetryAvailableAt(command.finishedAt, command.attemptNumber)
			: command.finishedAt;
		const outcome: string = retryable ? 'retryable_failed' : 'permanently_failed';
		return this.#transition(
			command,
			`INSERT INTO pdf_seal_attempt (
				id, job_id, attempt_number, action, outcome, error_code,
				provider_receipt_id, validator_receipt_id, sealed_sha256, started_at, finished_at
			 ) SELECT ?, id, ?, next_action, ?, ?, provider_receipt_id, NULL, sealed_sha256, ?, ?
			 FROM pdf_seal_job
			 WHERE id = ? AND status = 'processing' AND next_action <> 'publish'
				AND claim_token = ? AND attempts = ?`,
			[
				command.attemptId,
				command.attemptNumber,
				outcome,
				command.errorCode,
				command.startedAt,
				command.finishedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			],
			`UPDATE pdf_seal_job
			 SET status = 'failed', claim_token = NULL, locked_at = NULL,
				retryable = ?, last_error_code = ?, available_at = ?, failed_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND next_action <> 'publish'
				AND claim_token = ? AND attempts = ?`,
			[
				retryable ? 1 : 0,
				command.errorCode,
				availableAt,
				retryable ? null : command.finishedAt,
				command.finishedAt,
				command.jobId,
				command.claimToken,
				command.attemptNumber
			]
		);
	}

	async find(jobId: string): Promise<PdfSealJob | null> {
		const row: D1PdfSealJobRow | null = await this.#database
			.prepare(`SELECT ${JOB_COLUMNS} FROM pdf_seal_job WHERE id = ?`)
			.bind(jobId)
			.first<D1PdfSealJobRow>();
		return row === null ? null : mapRow(row);
	}

	async findByEnvelopeId(envelopeId: string): Promise<PdfSealJob | null> {
		const row: D1PdfSealJobRow | null = await this.#database
			.prepare(`SELECT ${JOB_COLUMNS} FROM pdf_seal_job WHERE envelope_id = ?`)
			.bind(envelopeId)
			.first<D1PdfSealJobRow>();
		return row === null ? null : mapRow(row);
	}

	async #transition(
		_command: { jobId: string },
		attemptSql: string,
		attemptBindings: readonly unknown[],
		updateSql: string,
		updateBindings: readonly unknown[]
	): Promise<boolean> {
		const attempt: D1PreparedStatement = this.#database
			.prepare(attemptSql)
			.bind(...attemptBindings);
		const update: D1PreparedStatement = this.#database.prepare(updateSql).bind(...updateBindings);
		const results: D1Result[] = await this.#database.batch([attempt, update]);
		return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
	}
}

function mapRow(row: D1PdfSealJobRow): PdfSealJob {
	const sealedArtifact: PdfSealSealedArtifact | null =
		row.sealed_object_key !== null &&
		row.sealed_sha256 !== null &&
		row.sealed_byte_size !== null &&
		row.achieved_profile !== null
			? {
					objectKey: row.sealed_object_key,
					sha256: row.sealed_sha256,
					byteSize: Number(row.sealed_byte_size),
					achievedProfile: row.achieved_profile
				}
			: null;
	const validationEvidence: PdfSealValidationEvidence | null =
		row.validator_receipt_id !== null &&
		row.validation_checks_json !== null &&
		row.validation_report_object_key !== null &&
		row.validation_report_sha256 !== null &&
		row.validation_report_byte_size !== null &&
		row.validated_at !== null
			? {
					validatorReceiptId: row.validator_receipt_id,
					checks: JSON.parse(row.validation_checks_json) as PdfSealValidationChecks,
					reportObjectKey: row.validation_report_object_key,
					reportSha256: row.validation_report_sha256,
					reportByteSize: Number(row.validation_report_byte_size),
					validatedAt: row.validated_at
				}
			: null;
	return {
		jobId: row.id,
		envelopeId: row.envelope_id,
		operationId: row.operation_id,
		validationId: row.validation_id,
		status: row.status,
		nextAction: row.next_action,
		attempts: Number(row.attempts),
		availableAt: row.available_at,
		lockedAt: row.locked_at,
		retryable: row.retryable === null ? null : row.retryable === 1,
		lastErrorCode: row.last_error_code,
		sourceObjectKey: row.source_object_key,
		sourceSha256: row.source_sha256,
		sourceByteSize: Number(row.source_byte_size),
		requestedProfile: row.requested_profile,
		signerCertificateSha256: row.signer_certificate_sha256,
		sealPolicyId: row.seal_policy_id,
		validationPolicyId: row.validation_policy_id,
		tsaPolicyId: row.tsa_policy_id,
		tsaTrustBundleSha256: row.tsa_trust_bundle_sha256,
		providerReceiptId: row.provider_receipt_id,
		sealedArtifact,
		validationEvidence,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		readyAt: row.ready_at,
		failedAt: row.failed_at
	};
}

function sameFrozenReference(job: PdfSealJob, command: EnqueuePdfSealJobCommand): boolean {
	return (
		job.jobId === command.jobId &&
		job.operationId === command.operationId &&
		job.validationId === command.validationId &&
		job.sourceObjectKey === command.sourceObjectKey &&
		job.sourceSha256 === command.sourceSha256 &&
		job.sourceByteSize === command.sourceByteSize &&
		job.requestedProfile === command.requestedProfile &&
		job.signerCertificateSha256 === command.signerCertificateSha256 &&
		job.sealPolicyId === command.sealPolicyId &&
		job.validationPolicyId === command.validationPolicyId &&
		job.tsaPolicyId === command.tsaPolicyId &&
		job.tsaTrustBundleSha256 === command.tsaTrustBundleSha256
	);
}

function assertClaimCommand(command: ClaimPdfSealJobsCommand): void {
	if (
		command.claimToken.length < 1 ||
		command.claimToken.length > 256 ||
		/[^\x21-\x7e]/.test(command.claimToken)
	) {
		throw new TypeError('claimToken is invalid');
	}
	assertTimestamp(command.claimedAt, 'claimedAt');
	assertTimestamp(command.staleBefore, 'staleBefore');
}

function assertTimestamp(value: string, name: string): void {
	const timestamp: number = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
		throw new TypeError(`${name} must be a canonical ISO timestamp`);
	}
}
