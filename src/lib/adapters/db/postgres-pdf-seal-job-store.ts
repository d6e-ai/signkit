import postgres from 'postgres';
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

interface PostgresPdfSealJobRow {
	id: string;
	envelope_id: string;
	operation_id: string;
	validation_id: string;
	status: PdfSealJobStatus;
	next_action: PdfSealJobAction;
	attempts: number | string;
	available_at: Date | string;
	locked_at: Date | string | null;
	retryable: boolean | null;
	last_error_code: string | null;
	source_object_key: string;
	source_sha256: string;
	source_byte_size: number | string;
	requested_profile: PdfSealProfile;
	signer_certificate_sha256: string;
	seal_policy_id: string;
	validation_policy_id: string;
	tsa_policy_id: string | null;
	tsa_trust_bundle_sha256: string | null;
	provider_receipt_id: string | null;
	sealed_object_key: string | null;
	sealed_sha256: string | null;
	sealed_byte_size: number | string | null;
	achieved_profile: PdfSealProfile | null;
	validator_receipt_id: string | null;
	validation_checks_json: string | null;
	validation_report_object_key: string | null;
	validation_report_sha256: string | null;
	validation_report_byte_size: number | string | null;
	validated_at: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
	ready_at: Date | string | null;
	failed_at: Date | string | null;
}

interface LockedJobRow {
	id: string;
	nextAction: PdfSealJobAction;
	attempts: number | string;
	sourceByteSize: number | string;
	requestedProfile: PdfSealProfile;
	providerReceiptId: string | null;
	sealedObjectKey: string | null;
	sealedSha256: string | null;
	sealedByteSize: number | string | null;
	achievedProfile: PdfSealProfile | null;
}

interface AttemptResult {
	outcome:
		| 'ambiguous'
		| 'checkpointed'
		| 'deferred'
		| 'publication_ready'
		| 'retryable_failed'
		| 'permanently_failed';
	errorCode: string | null;
	providerReceiptId: string | null;
	validatorReceiptId: string | null;
	sealedSha256: string | null;
}

interface TransitionCommand {
	jobId: string;
	claimToken: string;
	attemptId: string;
	attemptNumber: number;
	startedAt: string;
	finishedAt: string;
}

class PdfSealTransitionRollback {
	constructor(readonly result: boolean) {}
}

export class PostgresPdfSealJobStore implements PdfSealJobStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async enqueue(command: EnqueuePdfSealJobCommand): Promise<EnqueuePdfSealJobResult> {
		assertValidPdfSealFrozenReference(command);
		assertTimestamp(command.createdAt, 'createdAt');
		const inserted: PostgresPdfSealJobRow[] = await this.#sql<PostgresPdfSealJobRow[]>`
			INSERT INTO pdf_seal_job (
				id, envelope_id, operation_id, validation_id, status, next_action,
				claim_token, attempts, available_at, locked_at, retryable, last_error_code,
				source_object_key, source_sha256, source_byte_size, requested_profile,
				signer_certificate_sha256, seal_policy_id, validation_policy_id,
				tsa_policy_id, tsa_trust_bundle_sha256, created_at, updated_at
			)
			SELECT ${command.jobId}, pdf.envelope_id, ${command.operationId}, ${command.validationId},
				'pending', 'submit', NULL, 0, ${command.createdAt}::timestamptz,
				NULL, NULL, NULL, ${command.sourceObjectKey}, ${command.sourceSha256},
				${command.sourceByteSize}, ${command.requestedProfile},
				${command.signerCertificateSha256}, ${command.sealPolicyId},
				${command.validationPolicyId}, ${command.tsaPolicyId},
				${command.tsaTrustBundleSha256}, ${command.createdAt}::timestamptz,
				${command.createdAt}::timestamptz
			FROM completion_artifact_pdf AS pdf
			WHERE pdf.envelope_id = ${command.envelopeId}
				AND pdf.pdf_object_key = ${command.sourceObjectKey}
				AND pdf.pdf_sha256 = ${command.sourceSha256}
			ON CONFLICT DO NOTHING
			RETURNING *`;
		if (inserted.length === 1) return { outcome: 'enqueued', job: mapRow(inserted[0]) };
		const existing: PdfSealJob | null = await this.findByEnvelopeId(command.envelopeId);
		if (existing !== null) {
			return sameFrozenReference(existing, command)
				? { outcome: 'existing', job: existing }
				: { outcome: 'conflict' };
		}
		const exactSource: { envelopeId: string }[] = await this.#sql<{ envelopeId: string }[]>`
			SELECT envelope_id AS "envelopeId" FROM completion_artifact_pdf
			WHERE envelope_id = ${command.envelopeId}
				AND pdf_object_key = ${command.sourceObjectKey}
				AND pdf_sha256 = ${command.sourceSha256}`;
		return exactSource.length === 0 ? { outcome: 'source_mismatch' } : { outcome: 'conflict' };
	}

	async claim(command: ClaimPdfSealJobsCommand): Promise<readonly ClaimedPdfSealJob[]> {
		assertClaimCommand(command);
		const limit: number = command.jobId === undefined ? boundPdfSealClaimLimit(command.limit) : 1;
		return this.#sql.begin(
			async (sql: postgres.TransactionSql): Promise<readonly ClaimedPdfSealJob[]> => {
				const rows: PostgresPdfSealJobRow[] =
					command.jobId === undefined
						? await sql<PostgresPdfSealJobRow[]>`
						WITH candidates AS (
							SELECT id FROM pdf_seal_job
							WHERE next_action <> 'publish'
							AND ((status = 'pending' AND attempts < ${PDF_SEAL_JOB_MAX_ATTEMPTS}
									AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'failed' AND attempts < ${PDF_SEAL_JOB_MAX_ATTEMPTS}
									AND retryable AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing' AND attempts BETWEEN 1 AND ${PDF_SEAL_JOB_MAX_ATTEMPTS}
									AND locked_at < ${command.staleBefore}::timestamptz))
							ORDER BY available_at ASC, created_at ASC, id ASC
							LIMIT ${limit} FOR UPDATE SKIP LOCKED
						)
						UPDATE pdf_seal_job AS job
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}::timestamptz,
							attempts = CASE WHEN job.status = 'processing' THEN job.attempts ELSE job.attempts + 1 END,
							retryable = NULL, last_error_code = NULL, failed_at = NULL,
							updated_at = ${command.claimedAt}::timestamptz
						FROM candidates WHERE job.id = candidates.id
						RETURNING job.*`
						: await sql<PostgresPdfSealJobRow[]>`
						WITH candidates AS (
							SELECT id FROM pdf_seal_job
							WHERE id = ${command.jobId} AND next_action <> 'publish'
							AND ((status = 'pending' AND attempts < ${PDF_SEAL_JOB_MAX_ATTEMPTS}
									AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'failed' AND attempts < ${PDF_SEAL_JOB_MAX_ATTEMPTS}
									AND retryable AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing' AND attempts BETWEEN 1 AND ${PDF_SEAL_JOB_MAX_ATTEMPTS}
									AND locked_at < ${command.staleBefore}::timestamptz))
							ORDER BY available_at ASC, created_at ASC, id ASC
							LIMIT 1 FOR UPDATE SKIP LOCKED
						)
						UPDATE pdf_seal_job AS job
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}::timestamptz,
							attempts = CASE WHEN job.status = 'processing' THEN job.attempts ELSE job.attempts + 1 END,
							retryable = NULL, last_error_code = NULL, failed_at = NULL,
							updated_at = ${command.claimedAt}::timestamptz
						FROM candidates WHERE job.id = candidates.id
						RETURNING job.*`;
				return rows.map((row: PostgresPdfSealJobRow): ClaimedPdfSealJob => ({
					job: mapRow(row),
					claimToken: command.claimToken,
					startedAt: command.claimedAt
				}));
			}
		);
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
			['submit'],
			async (sql: postgres.TransactionSql): Promise<AttemptResult> => {
				await sql`UPDATE pdf_seal_job SET status = 'pending', next_action = 'recover_submit',
				claim_token = NULL, locked_at = NULL, available_at = ${command.finishedAt}::timestamptz,
				updated_at = ${command.finishedAt}::timestamptz WHERE id = ${command.jobId}`;
				return {
					outcome: 'ambiguous',
					errorCode: null,
					providerReceiptId: null,
					validatorReceiptId: null,
					sealedSha256: null
				};
			}
		);
	}

	async #recordProviderReceipt(command: RecordPdfSealProviderReceiptCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		return this.#transition(
			command,
			['submit', 'recover_submit'],
			async (sql: postgres.TransactionSql): Promise<AttemptResult> => {
				await sql`UPDATE pdf_seal_job SET status = 'pending', next_action = 'poll_provider',
				claim_token = NULL, locked_at = NULL, provider_receipt_id = ${command.providerReceiptId},
				available_at = ${command.finishedAt}::timestamptz,
				updated_at = ${command.finishedAt}::timestamptz WHERE id = ${command.jobId}`;
				return {
					outcome: 'checkpointed',
					errorCode: null,
					providerReceiptId: command.providerReceiptId,
					validatorReceiptId: null,
					sealedSha256: null
				};
			}
		);
	}

	async #deferProvider(command: DeferPdfSealProviderCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		const availableAt: string = pdfSealProviderPollAvailableAt(command.finishedAt);
		return this.#transition(
			command,
			['poll_provider'],
			async (sql: postgres.TransactionSql, row: LockedJobRow): Promise<AttemptResult> => {
				if (row.providerReceiptId !== command.providerReceiptId)
					throw new PdfSealTransitionRollback(false);
				await sql`UPDATE pdf_seal_job SET status = 'pending', claim_token = NULL, locked_at = NULL,
				available_at = ${availableAt}::timestamptz,
				updated_at = ${command.finishedAt}::timestamptz WHERE id = ${command.jobId}`;
				return {
					outcome: 'deferred',
					errorCode: null,
					providerReceiptId: command.providerReceiptId,
					validatorReceiptId: null,
					sealedSha256: null
				};
			}
		);
	}

	async #recordProviderResult(command: RecordPdfSealProviderResultCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		return this.#transition(
			command,
			['poll_provider'],
			async (sql: postgres.TransactionSql, row: LockedJobRow): Promise<AttemptResult> => {
				if (row.providerReceiptId !== command.providerReceiptId)
					throw new PdfSealTransitionRollback(false);
				assertValidPdfSealArtifact(
					command.sealedArtifact,
					Number(row.sourceByteSize),
					row.requestedProfile
				);
				await sql`UPDATE pdf_seal_job SET status = 'pending', next_action = 'validate',
				claim_token = NULL, locked_at = NULL, sealed_object_key = ${command.sealedArtifact.objectKey},
				sealed_sha256 = ${command.sealedArtifact.sha256}, sealed_byte_size = ${command.sealedArtifact.byteSize},
				achieved_profile = ${command.sealedArtifact.achievedProfile},
				available_at = ${command.finishedAt}::timestamptz,
				updated_at = ${command.finishedAt}::timestamptz WHERE id = ${command.jobId}`;
				return {
					outcome: 'checkpointed',
					errorCode: null,
					providerReceiptId: command.providerReceiptId,
					validatorReceiptId: null,
					sealedSha256: command.sealedArtifact.sha256
				};
			}
		);
	}

	async complete(command: CompletePdfSealJobCommand): Promise<boolean> {
		assertPdfSealAttemptCommand(command);
		assertPdfSealProviderReceipt(command.providerReceiptId);
		return this.#transition(
			command,
			['validate'],
			async (sql: postgres.TransactionSql, row: LockedJobRow): Promise<AttemptResult> => {
				if (
					row.providerReceiptId !== command.providerReceiptId ||
					!sameArtifact(row, command.sealedArtifact)
				) {
					throw new PdfSealTransitionRollback(false);
				}
				assertValidPdfSealArtifact(
					command.sealedArtifact,
					Number(row.sourceByteSize),
					row.requestedProfile
				);
				assertValidPdfSealValidationEvidence(command.validationEvidence, row.requestedProfile);
				const checksJson: string = JSON.stringify(command.validationEvidence.checks);
				await sql`UPDATE pdf_seal_job SET status = 'publication_ready', next_action = 'publish',
				claim_token = NULL, locked_at = NULL,
				validator_receipt_id = ${command.validationEvidence.validatorReceiptId},
				validation_checks_json = ${checksJson},
				validation_report_object_key = ${command.validationEvidence.reportObjectKey},
				validation_report_sha256 = ${command.validationEvidence.reportSha256},
				validation_report_byte_size = ${command.validationEvidence.reportByteSize},
				validated_at = ${command.validationEvidence.validatedAt}::timestamptz,
				ready_at = ${command.finishedAt}::timestamptz,
				updated_at = ${command.finishedAt}::timestamptz WHERE id = ${command.jobId}`;
				return {
					outcome: 'publication_ready',
					errorCode: null,
					providerReceiptId: command.providerReceiptId,
					validatorReceiptId: command.validationEvidence.validatorReceiptId,
					sealedSha256: command.sealedArtifact.sha256
				};
			}
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
		return this.#transition(
			command,
			['submit', 'recover_submit', 'poll_provider', 'validate'],
			async (sql: postgres.TransactionSql, row: LockedJobRow): Promise<AttemptResult> => {
				await sql`UPDATE pdf_seal_job SET status = 'failed', claim_token = NULL, locked_at = NULL,
				retryable = ${retryable}, last_error_code = ${command.errorCode},
				available_at = ${availableAt}::timestamptz,
				failed_at = ${retryable ? null : command.finishedAt}::timestamptz,
				updated_at = ${command.finishedAt}::timestamptz WHERE id = ${command.jobId}`;
				return {
					outcome: retryable ? 'retryable_failed' : 'permanently_failed',
					errorCode: command.errorCode,
					providerReceiptId: row.providerReceiptId,
					validatorReceiptId: null,
					sealedSha256: row.sealedSha256
				};
			}
		);
	}

	async find(jobId: string): Promise<PdfSealJob | null> {
		const rows: PostgresPdfSealJobRow[] = await this.#sql<PostgresPdfSealJobRow[]>`
			SELECT * FROM pdf_seal_job WHERE id = ${jobId}`;
		return rows[0] === undefined ? null : mapRow(rows[0]);
	}

	async findByEnvelopeId(envelopeId: string): Promise<PdfSealJob | null> {
		const rows: PostgresPdfSealJobRow[] = await this.#sql<PostgresPdfSealJobRow[]>`
			SELECT * FROM pdf_seal_job WHERE envelope_id = ${envelopeId}`;
		return rows[0] === undefined ? null : mapRow(rows[0]);
	}

	async #transition(
		command: TransitionCommand,
		allowedActions: readonly PdfSealJobAction[],
		mutate: (sql: postgres.TransactionSql, row: LockedJobRow) => Promise<AttemptResult>
	): Promise<boolean> {
		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql): Promise<boolean> => {
				const rows: LockedJobRow[] = await sql<LockedJobRow[]>`
					SELECT id, next_action AS "nextAction", attempts,
						source_byte_size AS "sourceByteSize", requested_profile AS "requestedProfile",
						provider_receipt_id AS "providerReceiptId", sealed_object_key AS "sealedObjectKey",
						sealed_sha256 AS "sealedSha256", sealed_byte_size AS "sealedByteSize",
						achieved_profile AS "achievedProfile"
					FROM pdf_seal_job WHERE id = ${command.jobId} AND status = 'processing'
						AND claim_token = ${command.claimToken} AND attempts = ${command.attemptNumber}
					FOR UPDATE`;
				const row: LockedJobRow | undefined = rows[0];
				if (row === undefined || !allowedActions.includes(row.nextAction)) {
					throw new PdfSealTransitionRollback(false);
				}
				const attempt: AttemptResult = await mutate(sql, row);
				await sql`INSERT INTO pdf_seal_attempt (
					id, job_id, attempt_number, action, outcome, error_code,
					provider_receipt_id, validator_receipt_id, sealed_sha256, started_at, finished_at
				) VALUES (${command.attemptId}, ${command.jobId}, ${command.attemptNumber},
					${row.nextAction}, ${attempt.outcome}, ${attempt.errorCode},
					${attempt.providerReceiptId}, ${attempt.validatorReceiptId}, ${attempt.sealedSha256},
					${command.startedAt}::timestamptz, ${command.finishedAt}::timestamptz)`;
				return true;
			});
		} catch (error: unknown) {
			if (error instanceof PdfSealTransitionRollback) return error.result;
			throw error;
		}
	}
}

function mapRow(row: PostgresPdfSealJobRow): PdfSealJob {
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
					validatedAt: iso(row.validated_at)
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
		availableAt: iso(row.available_at),
		lockedAt: row.locked_at === null ? null : iso(row.locked_at),
		retryable: row.retryable,
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
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
		readyAt: row.ready_at === null ? null : iso(row.ready_at),
		failedAt: row.failed_at === null ? null : iso(row.failed_at)
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

function sameArtifact(row: LockedJobRow, artifact: PdfSealSealedArtifact): boolean {
	return (
		row.sealedObjectKey === artifact.objectKey &&
		row.sealedSha256 === artifact.sha256 &&
		Number(row.sealedByteSize) === artifact.byteSize &&
		row.achievedProfile === artifact.achievedProfile
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

function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
