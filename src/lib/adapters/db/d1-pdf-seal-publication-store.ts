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

interface CandidateRow {
	job_id: string;
	envelope_id: string;
}

interface PublicationRow {
	job_id: string;
	envelope_id: string;
	operation_id: string;
	validation_id: string;
	source_object_key: string;
	source_sha256: string;
	source_byte_size: number;
	requested_profile: PdfSealProfile;
	signer_certificate_sha256: string;
	seal_policy_id: string;
	validation_policy_id: string;
	tsa_policy_id: string | null;
	tsa_trust_bundle_sha256: string | null;
	provider_receipt_id: string;
	sealed_object_key: string;
	sealed_sha256: string;
	sealed_byte_size: number;
	achieved_profile: PdfSealProfile;
	validator_receipt_id: string;
	validation_checks_json: string;
	validation_report_object_key: string;
	validation_report_sha256: string;
	validation_report_byte_size: number;
	validated_at: string;
	published_at: string;
	audit_event_id: string;
	audit_head_sequence: number;
	audit_head_event_hash: string;
}

interface CommandRow extends PublicationRow {
	anchor_audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
}

const PUBLICATION_COLUMNS: string = `job_id, envelope_id, operation_id, validation_id,
	source_object_key, source_sha256, source_byte_size, requested_profile,
	signer_certificate_sha256, seal_policy_id, validation_policy_id, tsa_policy_id,
	tsa_trust_bundle_sha256, provider_receipt_id, sealed_object_key, sealed_sha256,
	sealed_byte_size, achieved_profile, validator_receipt_id, validation_checks_json,
	validation_report_object_key, validation_report_sha256, validation_report_byte_size,
	validated_at, published_at, audit_event_id, audit_head_sequence, audit_head_event_hash`;

const COMMAND_COLUMNS: string = `job_id, envelope_id, operation_id, validation_id,
	source_object_key, source_sha256, source_byte_size, requested_profile,
	signer_certificate_sha256, seal_policy_id, validation_policy_id, tsa_policy_id,
	tsa_trust_bundle_sha256, provider_receipt_id, sealed_object_key, sealed_sha256,
	sealed_byte_size, achieved_profile, validator_receipt_id, validation_checks_json,
	validation_report_object_key, validation_report_sha256, validation_report_byte_size,
	validated_at, published_at, anchor_audit_event_id, audit_sequence, previous_audit_hash,
	audit_event_id, audit_event_hash, audit_payload_json`;

export class D1PdfSealPublicationStore implements PdfSealPublicationStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async discoverPdfSealPublicationCandidates(
		command: DiscoverPdfSealPublicationCandidatesCommand
	): Promise<readonly PdfSealPublicationCandidate[]> {
		const limit: number = boundPdfSealPublicationDiscoveryLimit(command.limit);
		const rows: D1Result<CandidateRow> = await this.#database
			.prepare(
				`SELECT job.id AS job_id, job.envelope_id AS envelope_id
				 FROM pdf_seal_job job
				 WHERE job.status = 'publication_ready' AND job.next_action = 'publish'
					AND NOT EXISTS (
						SELECT 1 FROM pdf_seal_publication pub WHERE pub.envelope_id = job.envelope_id
					)
				 ORDER BY job.ready_at ASC, job.id ASC
				 LIMIT ?`
			)
			.bind(limit)
			.all<CandidateRow>();
		return (rows.results ?? []).map((row: CandidateRow): PdfSealPublicationCandidate => ({
			jobId: row.job_id,
			envelopeId: row.envelope_id
		}));
	}

	async readAuditHeadForEnvelope(envelopeId: string): Promise<PdfSealAuditHead | null> {
		const row: { id: string; sequence: number; event_hash: string } | null = await this.#database
			.prepare(
				`SELECT id, sequence, event_hash FROM audit_event
				 WHERE envelope_id = ? ORDER BY sequence DESC LIMIT 1`
			)
			.bind(envelopeId)
			.first<{ id: string; sequence: number; event_hash: string }>();
		return row === null
			? null
			: { auditEventId: row.id, sequence: Number(row.sequence), eventHash: row.event_hash };
	}

	async publishPdfSeal(command: PublishPdfSealCommand): Promise<PublishPdfSealResult> {
		assertValidPublishPdfSealCommand(command);
		const replay: PublishPdfSealResult | null = await this.#resolveCommand(command);
		if (replay !== null) return replay;
		const checksJson: string = JSON.stringify(command.validationEvidence.checks);
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO pdf_seal_publish_command (${COMMAND_COLUMNS})
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.jobId,
				command.envelopeId,
				command.operationId,
				command.validationId,
				command.sourceObjectKey,
				command.sourceSha256,
				command.sourceByteSize,
				command.requestedProfile,
				command.signerCertificateSha256,
				command.sealPolicyId,
				command.validationPolicyId,
				command.tsaPolicyId,
				command.tsaTrustBundleSha256,
				command.providerReceiptId,
				command.sealedArtifact.objectKey,
				command.sealedArtifact.sha256,
				command.sealedArtifact.byteSize,
				command.sealedArtifact.achievedProfile,
				command.validationEvidence.validatorReceiptId,
				checksJson,
				command.validationEvidence.reportObjectKey,
				command.validationEvidence.reportSha256,
				command.validationEvidence.reportByteSize,
				command.validationEvidence.validatedAt,
				command.publishedAt,
				command.anchorAuditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventId,
				command.auditEventHash,
				command.auditPayloadJson
			);
		try {
			await this.#database.batch([statement]);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			// The command trigger rolls the INSERT back on a failed predicate, so
			// a caught failure here does not by itself prove which predicate (if
			// any) failed. Re-evaluate the exact predicates the trigger checks:
			// only when they prove a real conflict do we classify as
			// stale/integrity; otherwise rethrow so the caller can retry.
			const classified: PublishPdfSealResult | null = await this.#resolveCommand(command);
			if (classified !== null) return classified;
			if (!(await this.#jobEvidenceMatches(command))) return { outcome: 'stale' };
			if (!(await this.#publishPredicatesSatisfied(command))) return { outcome: 'integrity_error' };
			throw error;
		}
	}

	async readPdfSealPublicationByEnvelope(
		envelopeId: string
	): Promise<PdfSealPublicationRecord | null> {
		const row: PublicationRow | null = await this.#database
			.prepare(`SELECT ${PUBLICATION_COLUMNS} FROM pdf_seal_publication WHERE envelope_id = ?`)
			.bind(envelopeId)
			.first<PublicationRow>();
		return row === null ? null : mapPublicationRow(row);
	}

	async #jobEvidenceMatches(command: PublishPdfSealCommand): Promise<boolean> {
		const row: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM pdf_seal_job
				 WHERE id = ? AND envelope_id = ? AND operation_id = ? AND validation_id = ?
					AND status = 'publication_ready' AND next_action = 'publish'
					AND source_object_key = ? AND source_sha256 = ? AND source_byte_size = ?
					AND requested_profile = ? AND signer_certificate_sha256 = ?
					AND seal_policy_id = ? AND validation_policy_id = ?
					AND tsa_policy_id IS ? AND tsa_trust_bundle_sha256 IS ?
					AND provider_receipt_id = ? AND sealed_object_key = ? AND sealed_sha256 = ?
					AND sealed_byte_size = ? AND achieved_profile = ?
					AND validator_receipt_id = ? AND validation_checks_json = ?
					AND validation_report_object_key = ? AND validation_report_sha256 = ?
					AND validation_report_byte_size = ? AND validated_at = ?`
			)
			.bind(
				command.jobId,
				command.envelopeId,
				command.operationId,
				command.validationId,
				command.sourceObjectKey,
				command.sourceSha256,
				command.sourceByteSize,
				command.requestedProfile,
				command.signerCertificateSha256,
				command.sealPolicyId,
				command.validationPolicyId,
				command.tsaPolicyId,
				command.tsaTrustBundleSha256,
				command.providerReceiptId,
				command.sealedArtifact.objectKey,
				command.sealedArtifact.sha256,
				command.sealedArtifact.byteSize,
				command.sealedArtifact.achievedProfile,
				command.validationEvidence.validatorReceiptId,
				JSON.stringify(command.validationEvidence.checks),
				command.validationEvidence.reportObjectKey,
				command.validationEvidence.reportSha256,
				command.validationEvidence.reportByteSize,
				command.validationEvidence.validatedAt
			)
			.first<{ ok: number }>();
		return row !== null;
	}

	/** Re-evaluates the same envelope, source, and audit-anchor/head predicates the D1 trigger checks. */
	async #publishPredicatesSatisfied(command: PublishPdfSealCommand): Promise<boolean> {
		const envelope: { ok: number } | null = await this.#database
			.prepare(`SELECT 1 AS ok FROM envelope WHERE id = ? AND status = 'completed'`)
			.bind(command.envelopeId)
			.first<{ ok: number }>();
		if (envelope === null) return false;

		const source: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM completion_artifact_pdf
				 WHERE envelope_id = ? AND pdf_object_key = ? AND pdf_sha256 = ? AND pdf_byte_size = ?`
			)
			.bind(
				command.envelopeId,
				command.sourceObjectKey,
				command.sourceSha256,
				command.sourceByteSize
			)
			.first<{ ok: number }>();
		if (source === null) return false;

		const anchor: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM audit_event
				 WHERE envelope_id = ? AND id = ? AND sequence = ? AND event_hash = ?`
			)
			.bind(
				command.envelopeId,
				command.anchorAuditEventId,
				command.expectedAuditSequence,
				command.previousAuditHash
			)
			.first<{ ok: number }>();
		if (anchor === null) return false;

		const newer: { ok: number } | null = await this.#database
			.prepare(`SELECT 1 AS ok FROM audit_event WHERE envelope_id = ? AND sequence >= ?`)
			.bind(command.envelopeId, command.expectedAuditSequence + 1)
			.first<{ ok: number }>();
		return newer === null;
	}

	async #resolveCommand(key: PublishPdfSealCommand): Promise<PublishPdfSealResult | null> {
		const row: CommandRow | null = await this.#database
			.prepare(`SELECT ${COMMAND_COLUMNS} FROM pdf_seal_publish_command WHERE job_id = ?`)
			.bind(key.jobId)
			.first<CommandRow>();
		if (row === null) return null;
		if (!sameEvidence(row, key)) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}
}

function mapPublicationRow(row: PublicationRow): PdfSealPublicationRecord {
	return {
		jobId: row.job_id,
		envelopeId: row.envelope_id,
		operationId: row.operation_id,
		validationId: row.validation_id,
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
		sealedArtifact: {
			objectKey: row.sealed_object_key,
			sha256: row.sealed_sha256,
			byteSize: Number(row.sealed_byte_size),
			achievedProfile: row.achieved_profile
		},
		validationEvidence: {
			validatorReceiptId: row.validator_receipt_id,
			checks: JSON.parse(row.validation_checks_json) as PdfSealValidationChecks,
			reportObjectKey: row.validation_report_object_key,
			reportSha256: row.validation_report_sha256,
			reportByteSize: Number(row.validation_report_byte_size),
			validatedAt: row.validated_at
		},
		publishedAt: row.published_at,
		auditEventId: row.audit_event_id,
		auditHeadSequence: Number(row.audit_head_sequence),
		auditHeadEventHash: row.audit_head_event_hash
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
		jobId: row.job_id,
		envelopeId: row.envelope_id,
		sealedSha256: row.sealed_sha256,
		sealedByteSize: Number(row.sealed_byte_size),
		achievedProfile: row.achieved_profile,
		validationReportSha256: row.validation_report_sha256,
		validatedAt: row.validated_at,
		publishedAt: row.published_at,
		auditEventId: row.audit_event_id
	};
}

function sameEvidence(row: CommandRow, key: PublishPdfSealCommand): boolean {
	return (
		row.envelope_id === key.envelopeId &&
		row.operation_id === key.operationId &&
		row.validation_id === key.validationId &&
		row.source_object_key === key.sourceObjectKey &&
		row.source_sha256 === key.sourceSha256 &&
		row.source_byte_size === key.sourceByteSize &&
		row.requested_profile === key.requestedProfile &&
		row.signer_certificate_sha256 === key.signerCertificateSha256 &&
		row.seal_policy_id === key.sealPolicyId &&
		row.validation_policy_id === key.validationPolicyId &&
		row.tsa_policy_id === key.tsaPolicyId &&
		row.tsa_trust_bundle_sha256 === key.tsaTrustBundleSha256 &&
		row.provider_receipt_id === key.providerReceiptId &&
		row.sealed_object_key === key.sealedArtifact.objectKey &&
		row.sealed_sha256 === key.sealedArtifact.sha256 &&
		row.sealed_byte_size === key.sealedArtifact.byteSize &&
		row.achieved_profile === key.sealedArtifact.achievedProfile &&
		row.validator_receipt_id === key.validationEvidence.validatorReceiptId &&
		row.validation_checks_json === JSON.stringify(key.validationEvidence.checks) &&
		row.validation_report_object_key === key.validationEvidence.reportObjectKey &&
		row.validation_report_sha256 === key.validationEvidence.reportSha256 &&
		row.validation_report_byte_size === key.validationEvidence.reportByteSize &&
		row.validated_at === key.validationEvidence.validatedAt &&
		row.published_at === key.publishedAt &&
		row.anchor_audit_event_id === key.anchorAuditEventId &&
		row.audit_sequence === key.expectedAuditSequence + 1 &&
		row.previous_audit_hash === key.previousAuditHash &&
		row.audit_event_id === key.auditEventId &&
		row.audit_event_hash === key.auditEventHash &&
		row.audit_payload_json === key.auditPayloadJson
	);
}
