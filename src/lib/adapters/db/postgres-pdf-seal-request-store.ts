import postgres from 'postgres';
import {
	assertValidRequestPdfSealCommand,
	sanitizePublicPdfSealErrorCode,
	type PdfSealRequestStore,
	type PublicPdfSealJobSummary,
	type PublicPdfSealStoreStatus,
	type RequestPdfSealCommand,
	type RequestPdfSealResult
} from '$lib/ports/pdf-seal-request-store';
import type { PdfSealProfile } from '$lib/ports/pdf-seal-provider';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

interface RequestRow {
	requestHash: string;
	jobId: string;
	envelopeId: string;
	requestedProfile: PdfSealProfile;
	requestedAt: Date | string;
	jobMatches: boolean;
}

interface SourceRow {
	objectKey: string;
	sha256: string;
	byteSize: number | string | null;
}

interface StatusRow {
	envelopeId: string;
	sourceAvailable: boolean;
	jobId: string | null;
	requestedProfile: PdfSealProfile | null;
	requestedAt: Date | string | null;
	jobStatus: 'pending' | 'processing' | 'failed' | 'publication_ready' | null;
	attemptSequence: number | string | null;
	retryable: boolean | null;
	lastErrorCode: string | null;
	publishedAt: Date | string | null;
	achievedProfile: PdfSealProfile | null;
	signerCertificateSha256: string | null;
	sealedSha256: string | null;
	sealedByteSize: number | string | null;
	validationReportSha256: string | null;
	validatedAt: Date | string | null;
}

export class PostgresPdfSealRequestStore implements PdfSealRequestStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async request(command: RequestPdfSealCommand): Promise<RequestPdfSealResult> {
		assertValidRequestPdfSealCommand(command);
		try {
			return await this.#sql.begin(
				async (sql: postgres.TransactionSql): Promise<RequestPdfSealResult> => {
					const byKey: RequestRow | null = await findByActorKey(sql, command, true);
					if (byKey !== null) return classifyKeyReplay(byKey, command);

					const envelopes: { id: string }[] = await sql<{ id: string }[]>`
						SELECT id FROM envelope WHERE id = ${command.envelopeId} FOR UPDATE`;
					if (envelopes.length === 0) return { outcome: 'not_found' };

					const byEnvelope: RequestRow | null = await findByEnvelope(sql, command.envelopeId, true);
					if (byEnvelope !== null) return existingEnvelope(byEnvelope);

					const sources: SourceRow[] = await sql<SourceRow[]>`
						SELECT pdf_object_key AS "objectKey", pdf_sha256 AS sha256,
							pdf_byte_size AS "byteSize"
						FROM completion_artifact_pdf WHERE envelope_id = ${command.envelopeId}`;
					if (sources.length !== 1 || sources[0].byteSize === null) {
						return { outcome: 'source_unavailable' };
					}
					const source: SourceRow = sources[0];

					await sql`
						INSERT INTO pdf_seal_job (
							id, envelope_id, operation_id, validation_id, status, next_action,
							claim_token, attempt_sequence, retry_failures, available_at, locked_at,
							retryable, last_error_code, source_object_key, source_sha256, source_byte_size,
							requested_profile, signer_certificate_sha256, seal_policy_id,
							validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, created_at, updated_at
						) VALUES (
							${command.jobId}, ${command.envelopeId}, ${command.operationId}, ${command.validationId},
							'pending', 'submit', NULL, 0, 0, ${command.requestedAt}::timestamptz,
							NULL, NULL, NULL, ${source.objectKey}, ${source.sha256}, ${Number(source.byteSize)},
							${command.requestedProfile}, ${command.signerCertificateSha256},
							${command.sealPolicyId}, ${command.validationPolicyId}, ${command.tsaPolicyId},
							${command.tsaTrustBundleSha256}, ${command.requestedAt}::timestamptz,
							${command.requestedAt}::timestamptz
						)`;

					await sql`
						INSERT INTO pdf_seal_request_command (
							actor_type, actor_id, idempotency_key, request_hash,
							envelope_id, job_id, operation_id, validation_id,
							source_object_key, source_sha256, source_byte_size,
							requested_profile, signer_certificate_sha256, seal_policy_id,
							validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, requested_at
						) VALUES (
							${command.actor.type}, ${command.actor.id}, ${command.idempotencyKey},
							${command.requestHash}, ${command.envelopeId}, ${command.jobId},
							${command.operationId}, ${command.validationId}, ${source.objectKey},
							${source.sha256}, ${Number(source.byteSize)}, ${command.requestedProfile},
							${command.signerCertificateSha256}, ${command.sealPolicyId},
							${command.validationPolicyId}, ${command.tsaPolicyId},
							${command.tsaTrustBundleSha256}, ${command.requestedAt}::timestamptz
						)`;

					return { outcome: 'requested', job: commandJob(command) };
				}
			);
		} catch {
			// A concurrent uniqueness failure aborts the transaction. Re-read durable
			// evidence after rollback; never branch on PostgreSQL error strings/codes.
			const classified: RequestPdfSealResult | null = await this.#classifyAfterFailure(command);
			if (classified !== null) return classified;
			throw new Error('PDF seal request failed without classifiable durable evidence');
		}
	}

	async findStatus(envelopeId: string): Promise<PublicPdfSealStoreStatus> {
		const rows: StatusRow[] = await this.#sql<StatusRow[]>`
			SELECT envelope.id AS "envelopeId", (pdf.pdf_byte_size IS NOT NULL) AS "sourceAvailable",
				request.job_id AS "jobId", request.requested_profile AS "requestedProfile",
				request.requested_at AS "requestedAt", job.status AS "jobStatus",
				job.attempt_sequence AS "attemptSequence", job.retryable,
				job.last_error_code AS "lastErrorCode", publication.published_at AS "publishedAt",
				publication.achieved_profile AS "achievedProfile",
				publication.signer_certificate_sha256 AS "signerCertificateSha256",
				publication.sealed_sha256 AS "sealedSha256",
				publication.sealed_byte_size AS "sealedByteSize",
				publication.validation_report_sha256 AS "validationReportSha256",
				publication.validated_at AS "validatedAt"
			FROM envelope
			LEFT JOIN completion_artifact_pdf AS pdf ON pdf.envelope_id = envelope.id
			LEFT JOIN pdf_seal_request_command AS request ON request.envelope_id = envelope.id
			LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
			LEFT JOIN pdf_seal_publication AS publication ON publication.envelope_id = envelope.id
			WHERE envelope.id = ${envelopeId}`;
		return mapStatus(rows[0] ?? null);
	}

	async #classifyAfterFailure(
		command: RequestPdfSealCommand
	): Promise<RequestPdfSealResult | null> {
		const byKey: RequestRow | null = await findByActorKey(this.#sql, command, false);
		if (byKey !== null) return classifyKeyReplay(byKey, command);
		const byEnvelope: RequestRow | null = await findByEnvelope(
			this.#sql,
			command.envelopeId,
			false
		);
		if (byEnvelope !== null) return existingEnvelope(byEnvelope);
		const rows: { sourceAvailable: boolean }[] = await this.#sql<{ sourceAvailable: boolean }[]>`
			SELECT (pdf.pdf_byte_size IS NOT NULL) AS "sourceAvailable"
			FROM envelope LEFT JOIN completion_artifact_pdf AS pdf ON pdf.envelope_id = envelope.id
			WHERE envelope.id = ${command.envelopeId}`;
		if (rows.length === 0) return { outcome: 'not_found' };
		if (!rows[0].sourceAvailable) return { outcome: 'source_unavailable' };
		return null;
	}
}

async function findByActorKey(
	sql: Sql,
	command: RequestPdfSealCommand,
	lock: boolean
): Promise<RequestRow | null> {
	const rows: RequestRow[] = lock
		? await sql<RequestRow[]>`
			SELECT request.request_hash AS "requestHash", request.job_id AS "jobId",
				request.envelope_id AS "envelopeId", request.requested_profile AS "requestedProfile",
				request.requested_at AS "requestedAt",
				(job.id = request.job_id AND job.envelope_id = request.envelope_id) AS "jobMatches"
			FROM pdf_seal_request_command AS request
			LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
			WHERE request.actor_type = ${command.actor.type} AND request.actor_id = ${command.actor.id}
				AND request.idempotency_key = ${command.idempotencyKey}
			FOR UPDATE OF request`
		: await sql<RequestRow[]>`
			SELECT request.request_hash AS "requestHash", request.job_id AS "jobId",
				request.envelope_id AS "envelopeId", request.requested_profile AS "requestedProfile",
				request.requested_at AS "requestedAt",
				(job.id = request.job_id AND job.envelope_id = request.envelope_id) AS "jobMatches"
			FROM pdf_seal_request_command AS request
			LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
			WHERE request.actor_type = ${command.actor.type} AND request.actor_id = ${command.actor.id}
				AND request.idempotency_key = ${command.idempotencyKey}`;
	return rows[0] ?? null;
}

async function findByEnvelope(
	sql: Sql,
	envelopeId: string,
	lock: boolean
): Promise<RequestRow | null> {
	const rows: RequestRow[] = lock
		? await sql<RequestRow[]>`
			SELECT request.request_hash AS "requestHash", request.job_id AS "jobId",
				request.envelope_id AS "envelopeId", request.requested_profile AS "requestedProfile",
				request.requested_at AS "requestedAt",
				(job.id = request.job_id AND job.envelope_id = request.envelope_id) AS "jobMatches"
			FROM pdf_seal_request_command AS request
			LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
			WHERE request.envelope_id = ${envelopeId} FOR UPDATE OF request`
		: await sql<RequestRow[]>`
			SELECT request.request_hash AS "requestHash", request.job_id AS "jobId",
				request.envelope_id AS "envelopeId", request.requested_profile AS "requestedProfile",
				request.requested_at AS "requestedAt",
				(job.id = request.job_id AND job.envelope_id = request.envelope_id) AS "jobMatches"
			FROM pdf_seal_request_command AS request
			LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
			WHERE request.envelope_id = ${envelopeId}`;
	return rows[0] ?? null;
}

function classifyKeyReplay(row: RequestRow, command: RequestPdfSealCommand): RequestPdfSealResult {
	if (row.requestHash !== command.requestHash) return { outcome: 'idempotency_conflict' };
	if (!row.jobMatches) throw new Error('PDF seal request receipt is inconsistent');
	return { outcome: 'replayed', job: requestRowJob(row) };
}

function existingEnvelope(row: RequestRow): RequestPdfSealResult {
	if (!row.jobMatches) throw new Error('PDF seal request receipt is inconsistent');
	return { outcome: 'existing_envelope', job: requestRowJob(row) };
}

function commandJob(command: RequestPdfSealCommand): PublicPdfSealJobSummary {
	return {
		jobId: command.jobId,
		envelopeId: command.envelopeId,
		requestedProfile: command.requestedProfile,
		requestedAt: command.requestedAt
	};
}

function requestRowJob(row: RequestRow): PublicPdfSealJobSummary {
	return {
		jobId: row.jobId,
		envelopeId: row.envelopeId,
		requestedProfile: row.requestedProfile,
		requestedAt: toIso(row.requestedAt)
	};
}

function mapStatus(row: StatusRow | null): PublicPdfSealStoreStatus {
	if (row === null) return { status: 'not_found' };
	if (row.jobId === null) return { status: 'not_requested', sourceAvailable: row.sourceAvailable };
	if (row.requestedProfile === null || row.requestedAt === null || row.jobStatus === null) {
		throw new Error('PDF seal request receipt is inconsistent');
	}
	const job: PublicPdfSealJobSummary = {
		jobId: row.jobId,
		envelopeId: row.envelopeId,
		requestedProfile: row.requestedProfile,
		requestedAt: toIso(row.requestedAt)
	};
	if (row.publishedAt !== null) {
		if (
			row.achievedProfile === null ||
			row.signerCertificateSha256 === null ||
			row.sealedSha256 === null ||
			row.sealedByteSize === null ||
			row.validationReportSha256 === null ||
			row.validatedAt === null
		) {
			throw new Error('PDF seal publication is inconsistent');
		}
		return {
			status: 'published',
			job,
			achievedProfile: row.achievedProfile,
			signerCertificateSha256: row.signerCertificateSha256,
			sealedSha256: row.sealedSha256,
			sealedByteSize: Number(row.sealedByteSize),
			validationReportSha256: row.validationReportSha256,
			validatedAt: toIso(row.validatedAt),
			publishedAt: toIso(row.publishedAt)
		};
	}
	const attempts: number = Number(row.attemptSequence ?? 0);
	if (row.jobStatus === 'failed') {
		return {
			status: 'failed',
			job,
			attempts,
			retryable: Boolean(row.retryable),
			lastErrorCode: sanitizePublicPdfSealErrorCode(row.lastErrorCode)
		};
	}
	return {
		status: row.jobStatus === 'processing' ? 'processing' : 'pending',
		job,
		attempts
	};
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : String(value);
}
