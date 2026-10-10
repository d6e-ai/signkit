import postgres from 'postgres';
import {
	assertValidPublishPdfSealCommand,
	boundPdfSealPublicationDiscoveryLimit,
	type DiscoverPdfSealPublicationCandidatesCommand,
	type PdfSealAuditHead,
	type PdfSealPublicationCandidate,
	type PdfSealPublicationRecord,
	type PdfSealPublicationStore,
	type PublishedPdfSeal,
	type PublishPdfSealCommand,
	type PublishPdfSealResult
} from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealProfile } from '$lib/ports/pdf-seal-provider';
import type { PdfSealValidationChecks } from '$lib/ports/pdf-seal-validator';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

interface CandidateRow {
	jobId: string;
	envelopeId: string;
}

interface PublicationRow {
	jobId: string;
	envelopeId: string;
	operationId: string;
	validationId: string;
	sourceObjectKey: string;
	sourceSha256: string;
	sourceByteSize: number | string;
	requestedProfile: PdfSealProfile;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
	providerReceiptId: string;
	sealedObjectKey: string;
	sealedSha256: string;
	sealedByteSize: number | string;
	achievedProfile: PdfSealProfile;
	validatorReceiptId: string;
	validationChecksJson: string;
	validationReportObjectKey: string;
	validationReportSha256: string;
	validationReportByteSize: number | string;
	validatedAt: Date | string;
	publishedAt: Date | string;
	auditEventId: string;
	auditHeadSequence: number | string;
	auditHeadEventHash: string;
}

interface CommandRow extends PublicationRow {
	anchorAuditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

interface JobLockRow {
	id: string;
	envelopeId: string;
	operationId: string;
	validationId: string;
	status: string;
	nextAction: string;
	sourceObjectKey: string;
	sourceSha256: string;
	sourceByteSize: number | string;
	requestedProfile: PdfSealProfile;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
	providerReceiptId: string | null;
	sealedObjectKey: string | null;
	sealedSha256: string | null;
	sealedByteSize: number | string | null;
	achievedProfile: PdfSealProfile | null;
	validatorReceiptId: string | null;
	validationChecksJson: string | null;
	validationReportObjectKey: string | null;
	validationReportSha256: string | null;
	validationReportByteSize: number | string | null;
	validatedAt: Date | string | null;
}

interface EnvelopeLockRow {
	status: string;
}

interface AnchorRow {
	sequence: number | string;
	eventHash: string;
}

const PUBLICATION_SELECT: string = `job_id AS "jobId", envelope_id AS "envelopeId",
	operation_id AS "operationId", validation_id AS "validationId",
	source_object_key AS "sourceObjectKey", source_sha256 AS "sourceSha256",
	source_byte_size AS "sourceByteSize", requested_profile AS "requestedProfile",
	signer_certificate_sha256 AS "signerCertificateSha256", seal_policy_id AS "sealPolicyId",
	validation_policy_id AS "validationPolicyId", tsa_policy_id AS "tsaPolicyId",
	tsa_trust_bundle_sha256 AS "tsaTrustBundleSha256", provider_receipt_id AS "providerReceiptId",
	sealed_object_key AS "sealedObjectKey", sealed_sha256 AS "sealedSha256",
	sealed_byte_size AS "sealedByteSize", achieved_profile AS "achievedProfile",
	validator_receipt_id AS "validatorReceiptId", validation_checks_json AS "validationChecksJson",
	validation_report_object_key AS "validationReportObjectKey",
	validation_report_sha256 AS "validationReportSha256",
	validation_report_byte_size AS "validationReportByteSize", validated_at AS "validatedAt",
	published_at AS "publishedAt", audit_event_id AS "auditEventId",
	audit_head_sequence AS "auditHeadSequence", audit_head_event_hash AS "auditHeadEventHash"`;

const COMMAND_SELECT: string = `job_id AS "jobId", envelope_id AS "envelopeId",
	operation_id AS "operationId", validation_id AS "validationId",
	source_object_key AS "sourceObjectKey", source_sha256 AS "sourceSha256",
	source_byte_size AS "sourceByteSize", requested_profile AS "requestedProfile",
	signer_certificate_sha256 AS "signerCertificateSha256", seal_policy_id AS "sealPolicyId",
	validation_policy_id AS "validationPolicyId", tsa_policy_id AS "tsaPolicyId",
	tsa_trust_bundle_sha256 AS "tsaTrustBundleSha256", provider_receipt_id AS "providerReceiptId",
	sealed_object_key AS "sealedObjectKey", sealed_sha256 AS "sealedSha256",
	sealed_byte_size AS "sealedByteSize", achieved_profile AS "achievedProfile",
	validator_receipt_id AS "validatorReceiptId", validation_checks_json AS "validationChecksJson",
	validation_report_object_key AS "validationReportObjectKey",
	validation_report_sha256 AS "validationReportSha256",
	validation_report_byte_size AS "validationReportByteSize", validated_at AS "validatedAt",
	published_at AS "publishedAt", anchor_audit_event_id AS "anchorAuditEventId",
	audit_sequence AS "auditSequence", previous_audit_hash AS "previousAuditHash",
	audit_event_id AS "auditEventId", audit_event_hash AS "auditEventHash",
	audit_payload_json AS "auditPayloadJson"`;

export class PostgresPdfSealPublicationStore implements PdfSealPublicationStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async discoverPdfSealPublicationCandidates(
		command: DiscoverPdfSealPublicationCandidatesCommand
	): Promise<readonly PdfSealPublicationCandidate[]> {
		const limit: number = boundPdfSealPublicationDiscoveryLimit(command.limit);
		const rows = await this.#sql<CandidateRow[]>`
			SELECT job.id AS "jobId", job.envelope_id AS "envelopeId"
			FROM pdf_seal_job job
			WHERE job.status = 'publication_ready' AND job.next_action = 'publish'
				AND NOT EXISTS (
					SELECT 1 FROM pdf_seal_publication pub WHERE pub.envelope_id = job.envelope_id
				)
			ORDER BY job.ready_at ASC, job.id ASC
			LIMIT ${limit}`;
		return rows.map((row: CandidateRow): PdfSealPublicationCandidate => ({
			jobId: row.jobId,
			envelopeId: row.envelopeId
		}));
	}

	async readAuditHeadForEnvelope(envelopeId: string): Promise<PdfSealAuditHead | null> {
		const rows = await this.#sql<
			{ auditEventId: string; sequence: number | string; eventHash: string }[]
		>`SELECT id AS "auditEventId", sequence, event_hash AS "eventHash"
			FROM audit_event WHERE envelope_id = ${envelopeId}
			ORDER BY sequence DESC LIMIT 1`;
		const row = rows[0];
		return row === undefined
			? null
			: {
					auditEventId: row.auditEventId,
					sequence: Number(row.sequence),
					eventHash: row.eventHash
				};
	}

	async publishPdfSeal(command: PublishPdfSealCommand): Promise<PublishPdfSealResult> {
		assertValidPublishPdfSealCommand(command);
		const checksJson: string = JSON.stringify(command.validationEvidence.checks);
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishPdfSealResult> => {
				const envelopeRows = await transaction<EnvelopeLockRow[]>`
					SELECT status FROM envelope WHERE id = ${command.envelopeId} FOR UPDATE`;
				const jobRows = await transaction<JobLockRow[]>`
					SELECT id, envelope_id AS "envelopeId", operation_id AS "operationId",
						validation_id AS "validationId", status, next_action AS "nextAction",
						source_object_key AS "sourceObjectKey", source_sha256 AS "sourceSha256",
						source_byte_size AS "sourceByteSize", requested_profile AS "requestedProfile",
						signer_certificate_sha256 AS "signerCertificateSha256",
						seal_policy_id AS "sealPolicyId", validation_policy_id AS "validationPolicyId",
						tsa_policy_id AS "tsaPolicyId", tsa_trust_bundle_sha256 AS "tsaTrustBundleSha256",
						provider_receipt_id AS "providerReceiptId", sealed_object_key AS "sealedObjectKey",
						sealed_sha256 AS "sealedSha256", sealed_byte_size AS "sealedByteSize",
						achieved_profile AS "achievedProfile", validator_receipt_id AS "validatorReceiptId",
						validation_checks_json AS "validationChecksJson",
						validation_report_object_key AS "validationReportObjectKey",
						validation_report_sha256 AS "validationReportSha256",
						validation_report_byte_size AS "validationReportByteSize",
						validated_at AS "validatedAt"
					FROM pdf_seal_job WHERE id = ${command.jobId} FOR UPDATE`;

				const replay: PublishPdfSealResult | null = await this.#resolveCommand(
					transaction,
					command
				);
				if (replay !== null) return replay;

				const job: JobLockRow | undefined = jobRows[0];
				if (job === undefined || !sameJobEvidence(job, command, checksJson)) {
					return { outcome: 'stale' };
				}

				const envelope: EnvelopeLockRow | undefined = envelopeRows[0];
				if (envelope === undefined || envelope.status !== 'completed') {
					return { outcome: 'integrity_error' };
				}

				const sourceRows = await transaction<{ ok: number }[]>`
					SELECT 1 AS ok FROM completion_artifact_pdf
					WHERE envelope_id = ${command.envelopeId} AND pdf_object_key = ${command.sourceObjectKey}
						AND pdf_sha256 = ${command.sourceSha256} AND pdf_byte_size = ${command.sourceByteSize}`;
				if (sourceRows.length === 0) return { outcome: 'integrity_error' };

				const anchorRows = await transaction<AnchorRow[]>`
					SELECT sequence, event_hash AS "eventHash" FROM audit_event
					WHERE envelope_id = ${command.envelopeId} AND id = ${command.anchorAuditEventId}`;
				const anchor: AnchorRow | undefined = anchorRows[0];
				if (
					anchor === undefined ||
					Number(anchor.sequence) !== command.expectedAuditSequence ||
					anchor.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'integrity_error' };
				}

				const newerRows = await transaction<{ sequence: number }[]>`
					SELECT sequence FROM audit_event
					WHERE envelope_id = ${command.envelopeId}
						AND sequence >= ${command.expectedAuditSequence + 1}
					LIMIT 1`;
				if (newerRows.length > 0) return { outcome: 'integrity_error' };

				await transaction`
					INSERT INTO pdf_seal_publication (
						job_id, envelope_id, operation_id, validation_id, source_object_key, source_sha256,
						source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id,
						validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id,
						sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile,
						validator_receipt_id, validation_checks_json, validation_report_object_key,
						validation_report_sha256, validation_report_byte_size, validated_at, published_at,
						anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, audit_event_id
					) VALUES (
						${command.jobId}, ${command.envelopeId}, ${command.operationId},
						${command.validationId}, ${command.sourceObjectKey}, ${command.sourceSha256},
						${command.sourceByteSize}, ${command.requestedProfile},
						${command.signerCertificateSha256}, ${command.sealPolicyId},
						${command.validationPolicyId}, ${command.tsaPolicyId},
						${command.tsaTrustBundleSha256}, ${command.providerReceiptId},
						${command.sealedArtifact.objectKey}, ${command.sealedArtifact.sha256},
						${command.sealedArtifact.byteSize}, ${command.sealedArtifact.achievedProfile},
						${command.validationEvidence.validatorReceiptId}, ${checksJson},
						${command.validationEvidence.reportObjectKey},
						${command.validationEvidence.reportSha256},
						${command.validationEvidence.reportByteSize},
						${command.validationEvidence.validatedAt}::timestamptz,
						${command.publishedAt}::timestamptz, ${command.anchorAuditEventId},
						${command.expectedAuditSequence + 1}, ${command.auditEventHash},
						${command.auditEventId}
					)`;

				await transaction`
					INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at, hash_version
					) VALUES (
						${command.auditEventId}, ${command.envelopeId},
						${command.expectedAuditSequence + 1}, 'envelope.pdf_seal_published',
						'system', 'pdf-seal-worker', ${command.auditPayloadJson},
						${command.previousAuditHash}, ${command.auditEventHash},
						${command.publishedAt}::timestamptz, 3
					)`;

				await transaction`
					INSERT INTO pdf_seal_publish_command (
						job_id, envelope_id, operation_id, validation_id, source_object_key, source_sha256,
						source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id,
						validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id,
						sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile,
						validator_receipt_id, validation_checks_json, validation_report_object_key,
						validation_report_sha256, validation_report_byte_size, validated_at, published_at,
						anchor_audit_event_id, audit_sequence, previous_audit_hash, audit_event_id,
						audit_event_hash, audit_payload_json
					) VALUES (
						${command.jobId}, ${command.envelopeId}, ${command.operationId},
						${command.validationId}, ${command.sourceObjectKey}, ${command.sourceSha256},
						${command.sourceByteSize}, ${command.requestedProfile},
						${command.signerCertificateSha256}, ${command.sealPolicyId},
						${command.validationPolicyId}, ${command.tsaPolicyId},
						${command.tsaTrustBundleSha256}, ${command.providerReceiptId},
						${command.sealedArtifact.objectKey}, ${command.sealedArtifact.sha256},
						${command.sealedArtifact.byteSize}, ${command.sealedArtifact.achievedProfile},
						${command.validationEvidence.validatorReceiptId}, ${checksJson},
						${command.validationEvidence.reportObjectKey},
						${command.validationEvidence.reportSha256},
						${command.validationEvidence.reportByteSize},
						${command.validationEvidence.validatedAt}::timestamptz,
						${command.publishedAt}::timestamptz, ${command.anchorAuditEventId},
						${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
						${command.auditEventId}, ${command.auditEventHash}, ${command.auditPayloadJson}
					)`;

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: PublishPdfSealResult | null = await this.#resolveCommand(
				this.#sql,
				command
			);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async readPdfSealPublicationByEnvelope(
		envelopeId: string
	): Promise<PdfSealPublicationRecord | null> {
		const rows = await this.#sql<PublicationRow[]>`
			SELECT ${this.#sql.unsafe(PUBLICATION_SELECT)}
			FROM pdf_seal_publication WHERE envelope_id = ${envelopeId}`;
		const row: PublicationRow | undefined = rows[0];
		return row === undefined ? null : mapPublicationRow(row);
	}

	async #resolveCommand(
		sql: Sql,
		key: PublishPdfSealCommand
	): Promise<PublishPdfSealResult | null> {
		const rows = await sql<CommandRow[]>`
			SELECT ${sql.unsafe(COMMAND_SELECT)}
			FROM pdf_seal_publish_command WHERE job_id = ${key.jobId}`;
		const row: CommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (!sameEvidence(row, key)) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}
}

function sameJobEvidence(
	job: JobLockRow,
	command: PublishPdfSealCommand,
	checksJson: string
): boolean {
	return (
		job.envelopeId === command.envelopeId &&
		job.operationId === command.operationId &&
		job.validationId === command.validationId &&
		job.status === 'publication_ready' &&
		job.nextAction === 'publish' &&
		job.sourceObjectKey === command.sourceObjectKey &&
		job.sourceSha256 === command.sourceSha256 &&
		Number(job.sourceByteSize) === command.sourceByteSize &&
		job.requestedProfile === command.requestedProfile &&
		job.signerCertificateSha256 === command.signerCertificateSha256 &&
		job.sealPolicyId === command.sealPolicyId &&
		job.validationPolicyId === command.validationPolicyId &&
		job.tsaPolicyId === command.tsaPolicyId &&
		job.tsaTrustBundleSha256 === command.tsaTrustBundleSha256 &&
		job.providerReceiptId === command.providerReceiptId &&
		job.sealedObjectKey === command.sealedArtifact.objectKey &&
		job.sealedSha256 === command.sealedArtifact.sha256 &&
		job.sealedByteSize !== null &&
		Number(job.sealedByteSize) === command.sealedArtifact.byteSize &&
		job.achievedProfile === command.sealedArtifact.achievedProfile &&
		job.validatorReceiptId === command.validationEvidence.validatorReceiptId &&
		job.validationChecksJson === checksJson &&
		job.validationReportObjectKey === command.validationEvidence.reportObjectKey &&
		job.validationReportSha256 === command.validationEvidence.reportSha256 &&
		job.validationReportByteSize !== null &&
		Number(job.validationReportByteSize) === command.validationEvidence.reportByteSize &&
		job.validatedAt !== null &&
		iso(job.validatedAt) === command.validationEvidence.validatedAt
	);
}

function mapPublicationRow(row: PublicationRow): PdfSealPublicationRecord {
	return {
		jobId: row.jobId,
		envelopeId: row.envelopeId,
		operationId: row.operationId,
		validationId: row.validationId,
		sourceObjectKey: row.sourceObjectKey,
		sourceSha256: row.sourceSha256,
		sourceByteSize: Number(row.sourceByteSize),
		requestedProfile: row.requestedProfile,
		signerCertificateSha256: row.signerCertificateSha256,
		sealPolicyId: row.sealPolicyId,
		validationPolicyId: row.validationPolicyId,
		tsaPolicyId: row.tsaPolicyId,
		tsaTrustBundleSha256: row.tsaTrustBundleSha256,
		providerReceiptId: row.providerReceiptId,
		sealedArtifact: {
			objectKey: row.sealedObjectKey,
			sha256: row.sealedSha256,
			byteSize: Number(row.sealedByteSize),
			achievedProfile: row.achievedProfile
		},
		validationEvidence: {
			validatorReceiptId: row.validatorReceiptId,
			checks: JSON.parse(row.validationChecksJson) as PdfSealValidationChecks,
			reportObjectKey: row.validationReportObjectKey,
			reportSha256: row.validationReportSha256,
			reportByteSize: Number(row.validationReportByteSize),
			validatedAt: iso(row.validatedAt)
		},
		publishedAt: iso(row.publishedAt),
		auditEventId: row.auditEventId,
		auditHeadSequence: Number(row.auditHeadSequence),
		auditHeadEventHash: row.auditHeadEventHash
	};
}

function resultFromCommand(command: PublishPdfSealCommand): PublishedPdfSeal {
	return {
		jobId: command.jobId,
		envelopeId: command.envelopeId,
		sealedSha256: command.sealedArtifact.sha256,
		sealedByteSize: command.sealedArtifact.byteSize,
		achievedProfile: command.sealedArtifact.achievedProfile,
		validationReportSha256: command.validationEvidence.reportSha256,
		validatedAt: command.validationEvidence.validatedAt,
		publishedAt: command.publishedAt,
		auditEventId: command.auditEventId
	};
}

function resultFromRow(row: CommandRow): PublishedPdfSeal {
	return {
		jobId: row.jobId,
		envelopeId: row.envelopeId,
		sealedSha256: row.sealedSha256,
		sealedByteSize: Number(row.sealedByteSize),
		achievedProfile: row.achievedProfile,
		validationReportSha256: row.validationReportSha256,
		validatedAt: iso(row.validatedAt),
		publishedAt: iso(row.publishedAt),
		auditEventId: row.auditEventId
	};
}

function sameEvidence(row: CommandRow, key: PublishPdfSealCommand): boolean {
	return (
		row.envelopeId === key.envelopeId &&
		row.operationId === key.operationId &&
		row.validationId === key.validationId &&
		row.sourceObjectKey === key.sourceObjectKey &&
		row.sourceSha256 === key.sourceSha256 &&
		Number(row.sourceByteSize) === key.sourceByteSize &&
		row.requestedProfile === key.requestedProfile &&
		row.signerCertificateSha256 === key.signerCertificateSha256 &&
		row.sealPolicyId === key.sealPolicyId &&
		row.validationPolicyId === key.validationPolicyId &&
		row.tsaPolicyId === key.tsaPolicyId &&
		row.tsaTrustBundleSha256 === key.tsaTrustBundleSha256 &&
		row.providerReceiptId === key.providerReceiptId &&
		row.sealedObjectKey === key.sealedArtifact.objectKey &&
		row.sealedSha256 === key.sealedArtifact.sha256 &&
		Number(row.sealedByteSize) === key.sealedArtifact.byteSize &&
		row.achievedProfile === key.sealedArtifact.achievedProfile &&
		row.validatorReceiptId === key.validationEvidence.validatorReceiptId &&
		row.validationChecksJson === JSON.stringify(key.validationEvidence.checks) &&
		row.validationReportObjectKey === key.validationEvidence.reportObjectKey &&
		row.validationReportSha256 === key.validationEvidence.reportSha256 &&
		Number(row.validationReportByteSize) === key.validationEvidence.reportByteSize &&
		iso(row.validatedAt) === key.validationEvidence.validatedAt &&
		iso(row.publishedAt) === key.publishedAt &&
		row.anchorAuditEventId === key.anchorAuditEventId &&
		Number(row.auditSequence) === key.expectedAuditSequence + 1 &&
		row.previousAuditHash === key.previousAuditHash &&
		row.auditEventId === key.auditEventId &&
		row.auditEventHash === key.auditEventHash &&
		row.auditPayloadJson === key.auditPayloadJson
	);
}

function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
