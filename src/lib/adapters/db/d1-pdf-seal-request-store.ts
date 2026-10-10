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

interface D1RequestRow {
	request_hash: string;
	job_id: string;
	envelope_id: string;
	requested_profile: PdfSealProfile;
	requested_at: string;
	job_matches: number;
}

interface D1StatusRow {
	envelope_id: string;
	source_available: number;
	job_id: string | null;
	requested_profile: PdfSealProfile | null;
	requested_at: string | null;
	job_status: 'pending' | 'processing' | 'failed' | 'publication_ready' | null;
	attempt_sequence: number | null;
	retryable: number | null;
	last_error_code: string | null;
	published_at: string | null;
	achieved_profile: PdfSealProfile | null;
	signer_certificate_sha256: string | null;
	sealed_sha256: string | null;
	sealed_byte_size: number | null;
	validation_report_sha256: string | null;
	validated_at: string | null;
}

export class D1PdfSealRequestStore implements PdfSealRequestStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async request(command: RequestPdfSealCommand): Promise<RequestPdfSealResult> {
		assertValidRequestPdfSealCommand(command);
		let inserted: boolean = false;
		try {
			const result: D1Result = await this.#database
				.prepare(
					`INSERT INTO pdf_seal_request_command (
						actor_type, actor_id, idempotency_key, request_hash,
						envelope_id, job_id, operation_id, validation_id,
						source_object_key, source_sha256, source_byte_size,
						requested_profile, signer_certificate_sha256, seal_policy_id,
						validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, requested_at
					)
					SELECT ?, ?, ?, ?, envelope.id, ?, ?, ?, pdf.pdf_object_key,
						pdf.pdf_sha256, pdf.pdf_byte_size, ?, ?, ?, ?, ?, ?, ?
					FROM envelope
					JOIN completion_artifact_pdf AS pdf ON pdf.envelope_id = envelope.id
					WHERE envelope.id = ? AND pdf.pdf_byte_size IS NOT NULL
					ON CONFLICT DO NOTHING`
				)
				.bind(
					command.actor.type,
					command.actor.id,
					command.idempotencyKey,
					command.requestHash,
					command.jobId,
					command.operationId,
					command.validationId,
					command.requestedProfile,
					command.signerCertificateSha256,
					command.sealPolicyId,
					command.validationPolicyId,
					command.tsaPolicyId,
					command.tsaTrustBundleSha256,
					command.requestedAt,
					command.envelopeId
				)
				.run();
			// SQLite `changes()` excludes writes performed by triggers, while D1 may
			// report a broader count. Either way, a positive count proves this command
			// inserted the receipt; exact replay remains evidence-checked below.
			inserted = (result.meta.changes ?? 0) > 0;
		} catch {
			// D1 exposes provider-specific constraint text. Classify below only from
			// durable evidence; an unexplained failure is never treated as replay.
		}

		const byKey: D1RequestRow | null = await this.#findByActorKey(command);
		if (byKey !== null) {
			if (byKey.request_hash !== command.requestHash) return { outcome: 'idempotency_conflict' };
			const job: PublicPdfSealJobSummary = requestRowJob(byKey);
			if (byKey.job_matches !== 1) throw new Error('PDF seal request receipt is inconsistent');
			return { outcome: inserted ? 'requested' : 'replayed', job };
		}

		const byEnvelope: D1RequestRow | null = await this.#findByEnvelope(command.envelopeId);
		if (byEnvelope !== null) {
			if (byEnvelope.job_matches !== 1) throw new Error('PDF seal request receipt is inconsistent');
			return { outcome: 'existing_envelope', job: requestRowJob(byEnvelope) };
		}

		const envelope: { source_available: number } | null = await this.#database
			.prepare(
				`SELECT CASE WHEN pdf.pdf_byte_size IS NOT NULL THEN 1 ELSE 0 END AS source_available
				 FROM envelope LEFT JOIN completion_artifact_pdf AS pdf ON pdf.envelope_id = envelope.id
				 WHERE envelope.id = ?`
			)
			.bind(command.envelopeId)
			.first<{ source_available: number }>();
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.source_available !== 1) return { outcome: 'source_unavailable' };
		throw new Error('PDF seal request failed without classifiable durable evidence');
	}

	async findStatus(envelopeId: string): Promise<PublicPdfSealStoreStatus> {
		const row: D1StatusRow | null = await this.#database
			.prepare(
				`SELECT envelope.id AS envelope_id,
					CASE WHEN pdf.pdf_byte_size IS NOT NULL THEN 1 ELSE 0 END AS source_available,
					request.job_id, request.requested_profile, request.requested_at,
					job.status AS job_status, job.attempt_sequence, job.retryable, job.last_error_code,
					publication.published_at, publication.achieved_profile,
					publication.signer_certificate_sha256, publication.sealed_sha256,
					publication.sealed_byte_size, publication.validation_report_sha256,
					publication.validated_at
				 FROM envelope
				 LEFT JOIN completion_artifact_pdf AS pdf ON pdf.envelope_id = envelope.id
				 LEFT JOIN pdf_seal_request_command AS request ON request.envelope_id = envelope.id
				 LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
				 LEFT JOIN pdf_seal_publication AS publication ON publication.envelope_id = envelope.id
				 WHERE envelope.id = ?`
			)
			.bind(envelopeId)
			.first<D1StatusRow>();
		return mapStatus(row);
	}

	async #findByActorKey(command: RequestPdfSealCommand): Promise<D1RequestRow | null> {
		return this.#database
			.prepare(
				`SELECT request.request_hash, request.job_id, request.envelope_id,
					request.requested_profile, request.requested_at,
					CASE WHEN job.id = request.job_id AND job.envelope_id = request.envelope_id
						THEN 1 ELSE 0 END AS job_matches
				 FROM pdf_seal_request_command AS request
				 LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
				 WHERE request.actor_type = ? AND request.actor_id = ? AND request.idempotency_key = ?`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey)
			.first<D1RequestRow>();
	}

	async #findByEnvelope(envelopeId: string): Promise<D1RequestRow | null> {
		return this.#database
			.prepare(
				`SELECT request.request_hash, request.job_id, request.envelope_id,
					request.requested_profile, request.requested_at,
					CASE WHEN job.id = request.job_id AND job.envelope_id = request.envelope_id
						THEN 1 ELSE 0 END AS job_matches
				 FROM pdf_seal_request_command AS request
				 LEFT JOIN pdf_seal_job AS job ON job.id = request.job_id
				 WHERE request.envelope_id = ?`
			)
			.bind(envelopeId)
			.first<D1RequestRow>();
	}
}

function requestRowJob(row: D1RequestRow): PublicPdfSealJobSummary {
	return {
		jobId: row.job_id,
		envelopeId: row.envelope_id,
		requestedProfile: row.requested_profile,
		requestedAt: row.requested_at
	};
}

function mapStatus(row: D1StatusRow | null): PublicPdfSealStoreStatus {
	if (row === null) return { status: 'not_found' };
	if (row.job_id === null)
		return { status: 'not_requested', sourceAvailable: row.source_available === 1 };
	if (row.requested_profile === null || row.requested_at === null || row.job_status === null) {
		throw new Error('PDF seal request receipt is inconsistent');
	}
	const job: PublicPdfSealJobSummary = {
		jobId: row.job_id,
		envelopeId: row.envelope_id,
		requestedProfile: row.requested_profile,
		requestedAt: row.requested_at
	};
	if (row.published_at !== null) {
		if (
			row.achieved_profile === null ||
			row.signer_certificate_sha256 === null ||
			row.sealed_sha256 === null ||
			row.sealed_byte_size === null ||
			row.validation_report_sha256 === null ||
			row.validated_at === null
		) {
			throw new Error('PDF seal publication is inconsistent');
		}
		return {
			status: 'published',
			job,
			achievedProfile: row.achieved_profile,
			signerCertificateSha256: row.signer_certificate_sha256,
			sealedSha256: row.sealed_sha256,
			sealedByteSize: Number(row.sealed_byte_size),
			validationReportSha256: row.validation_report_sha256,
			validatedAt: row.validated_at,
			publishedAt: row.published_at
		};
	}
	const attempts: number = Number(row.attempt_sequence ?? 0);
	if (row.job_status === 'failed') {
		return {
			status: 'failed',
			job,
			attempts,
			retryable: row.retryable === 1,
			lastErrorCode: sanitizePublicPdfSealErrorCode(row.last_error_code)
		};
	}
	return {
		status: row.job_status === 'processing' ? 'processing' : 'pending',
		job,
		attempts
	};
}
