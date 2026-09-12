import type { FieldType, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
import {
	MAX_COMPLETION_AUDIT_VERIFY_EVENTS,
	requireCanonicalIsoMillisecondTimestamp,
	type ClaimCompletionArtifactsCommand,
	type ClaimedCompletionArtifactJob,
	type CompletionArtifactStatusRow,
	type CompletionArtifactStore,
	type CompletionEvidence,
	type CompletionEvidenceAuditEvent,
	type CompletionEvidenceField,
	type CompletionEvidenceRecipient,
	type FailCompletionArtifactCommand,
	type FailCompletionArtifactResult,
	type PublishCompletionArtifactCommand,
	type PublishCompletionArtifactResult,
	type PublishedCompletionArtifact,
	type ReadClaimedCompletionArtifactCommand
} from '$lib/ports/completion-artifact-store';

const CLAIM_CANDIDATE_COLUMNS: string = `job.organization_id AS organization_id,
	job.envelope_id AS envelope_id,
	job.attempts AS attempts,
	job.locked_at AS locked_at,
	envelope.title AS envelope_title,
	envelope.sent_commit_sha AS sent_commit_sha,
	envelope.repository_archive_key AS repository_archive_key,
	envelope.repository_archive_sha256 AS repository_archive_sha256,
	envelope.field_generation AS field_generation`;

const CLAIM_CANDIDATE_JOIN: string = `FROM completion_artifact_job job
	INNER JOIN envelope
		ON envelope.organization_id = job.organization_id
		AND envelope.id = job.envelope_id
	WHERE (
			(job.status IN ('pending', 'failed') AND job.retryable = 1 AND job.available_at <= ?)
			OR (job.status = 'processing' AND job.locked_at < ?)
		)
		AND envelope.status = 'completed'`;

interface ClaimCandidateRow {
	organization_id: string;
	envelope_id: string;
	attempts: number;
	locked_at: string | null;
	envelope_title: string;
	sent_commit_sha: string | null;
	repository_archive_key: string | null;
	repository_archive_sha256: string | null;
	field_generation: number;
}

interface RecipientEvidenceRow {
	id: string;
	role: RecipientRole;
	routing_order: number;
	status: RecipientStatus;
	decision_event_id: string | null;
	decision_occurred_at: string | null;
}

interface FieldEvidenceRow {
	field_id: string;
	field_type: FieldType;
	value_json: string;
	value_sha256: string;
}

interface AuditEvidenceRow {
	id: string;
	sequence: number;
	event_type: string;
	actor_type: string;
	actor_id: string | null;
	payload_json: string;
	previous_hash: string | null;
	event_hash: string;
	occurred_at: string;
}

interface PublishCommandRow {
	envelope_id: string;
	sent_commit_sha: string;
	field_generation: number;
	anchor_audit_event_id: string;
	manifest_sha256: string;
	json_object_key: string;
	json_sha256: string;
	markdown_object_key: string;
	markdown_sha256: string;
	updated_at: string;
	audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
}

interface StatusRow {
	envelope_id: string;
	envelope_status: string;
	job_status: 'pending' | 'processing' | 'published' | 'failed' | null;
	attempts: number | null;
	last_error: string | null;
	available_at: string | null;
	artifact_manifest_sha256: string | null;
	artifact_json_sha256: string | null;
	artifact_markdown_sha256: string | null;
	artifact_published_at: string | null;
	artifact_audit_event_id: string | null;
}

export class D1CompletionArtifactStore implements CompletionArtifactStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async claimPendingCompletionArtifacts(
		command: ClaimCompletionArtifactsCommand
	): Promise<readonly ClaimedCompletionArtifactJob[]> {
		const discover: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO completion_artifact_job (
					organization_id, envelope_id, status, attempts, available_at, retryable,
					created_at, updated_at
				)
				SELECT envelope.organization_id, envelope.id, 'pending', 0, ?, 1, ?, ?
				FROM envelope
				WHERE envelope.status = 'completed'
					AND NOT EXISTS (
						SELECT 1 FROM completion_artifact artifact
						WHERE artifact.organization_id = envelope.organization_id
							AND artifact.envelope_id = envelope.id
					)
					AND NOT EXISTS (
						SELECT 1 FROM completion_artifact_job job
						WHERE job.organization_id = envelope.organization_id
							AND job.envelope_id = envelope.id
					)
				ORDER BY envelope.updated_at ASC, envelope.id ASC
				LIMIT ?
				ON CONFLICT (organization_id, envelope_id) DO NOTHING`
			)
			.bind(command.claimedAt, command.claimedAt, command.claimedAt, command.discoveryLimit);
		const claim: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE completion_artifact_job
				 SET status = 'processing', claim_token = ?, locked_at = ?, attempts = attempts + 1,
					updated_at = ?
				 WHERE rowid IN (
					SELECT job.rowid
					${CLAIM_CANDIDATE_JOIN}
					ORDER BY job.available_at ASC, job.envelope_id ASC
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
				`SELECT ${CLAIM_CANDIDATE_COLUMNS}
				 FROM completion_artifact_job job
				 INNER JOIN envelope
					ON envelope.organization_id = job.organization_id
					AND envelope.id = job.envelope_id
				 WHERE job.status = 'processing' AND job.claim_token = ?
				 ORDER BY job.available_at ASC, job.envelope_id ASC`
			)
			.bind(command.claimToken);
		const results: D1Result[] = await this.#database.batch([discover, claim, readClaim]);
		const rows: readonly ClaimCandidateRow[] = results[2].results as ClaimCandidateRow[];
		return rows.map(toClaimedJob);
	}

	async readClaimedCompletionArtifact(
		command: ReadClaimedCompletionArtifactCommand
	): Promise<ClaimedCompletionArtifactJob | null> {
		const row: ClaimCandidateRow | null = await this.#database
			.prepare(
				`SELECT ${CLAIM_CANDIDATE_COLUMNS}
				 FROM completion_artifact_job job
				 INNER JOIN envelope
					ON envelope.organization_id = job.organization_id
					AND envelope.id = job.envelope_id
				 WHERE job.organization_id = ? AND job.envelope_id = ?
					AND job.status = 'processing' AND job.claim_token = ?`
			)
			.bind(command.organizationId, command.envelopeId, command.claimToken)
			.first<ClaimCandidateRow>();
		return row === null ? null : toClaimedJob(row);
	}

	async readCompletionEvidence(
		organizationId: string,
		envelopeId: string
	): Promise<CompletionEvidence> {
		const recipients: D1Result<RecipientEvidenceRow> = await this.#database
			.prepare(
				`SELECT recipient.id AS id, recipient.role AS role,
					recipient.routing_order AS routing_order, recipient.status AS status,
					(SELECT decision.id FROM audit_event decision
						WHERE decision.organization_id = recipient.organization_id
							AND decision.envelope_id = recipient.envelope_id
							AND decision.actor_id = recipient.id
							AND decision.event_type IN ('recipient.signed', 'recipient.approved')
						ORDER BY decision.sequence ASC LIMIT 1) AS decision_event_id,
					(SELECT decision.occurred_at FROM audit_event decision
						WHERE decision.organization_id = recipient.organization_id
							AND decision.envelope_id = recipient.envelope_id
							AND decision.actor_id = recipient.id
							AND decision.event_type IN ('recipient.signed', 'recipient.approved')
						ORDER BY decision.sequence ASC LIMIT 1) AS decision_occurred_at
				 FROM recipient
				 WHERE recipient.organization_id = ? AND recipient.envelope_id = ?
				 ORDER BY recipient.id`
			)
			.bind(organizationId, envelopeId)
			.all<RecipientEvidenceRow>();
		const fields: D1Result<FieldEvidenceRow> = await this.#database
			.prepare(
				`SELECT field_id, field_type, value_json, value_sha256
				 FROM field_value
				 WHERE organization_id = ? AND envelope_id = ?
				 ORDER BY field_id`
			)
			.bind(organizationId, envelopeId)
			.all<FieldEvidenceRow>();
		const auditEvents: D1Result<AuditEvidenceRow> = await this.#database
			.prepare(
				`SELECT id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash,
					event_hash, occurred_at
				 FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ?
				 ORDER BY sequence ASC
				 LIMIT ?`
			)
			.bind(organizationId, envelopeId, MAX_COMPLETION_AUDIT_VERIFY_EVENTS + 1)
			.all<AuditEvidenceRow>();

		return {
			recipients: recipients.results.map(
				(row: RecipientEvidenceRow): CompletionEvidenceRecipient => ({
					id: row.id,
					role: row.role,
					routingOrder: row.routing_order,
					status: row.status,
					decisionEventId: row.decision_event_id,
					decisionOccurredAt: row.decision_occurred_at
				})
			),
			fields: fields.results.map((row: FieldEvidenceRow): CompletionEvidenceField => ({
				id: row.field_id,
				fieldType: row.field_type,
				valueJson: row.value_json,
				valueSha256: row.value_sha256
			})),
			auditEvents: auditEvents.results.map(
				(row: AuditEvidenceRow): CompletionEvidenceAuditEvent => ({
					id: row.id,
					sequence: row.sequence,
					eventType: row.event_type,
					actorType: row.actor_type,
					actorId: row.actor_id,
					payloadJson: row.payload_json,
					previousHash: row.previous_hash,
					eventHash: row.event_hash,
					occurredAt: requireCanonicalIsoMillisecondTimestamp(row.occurred_at)
				})
			)
		};
	}

	async publishCompletionArtifact(
		command: PublishCompletionArtifactCommand
	): Promise<PublishCompletionArtifactResult> {
		const replay: PublishCompletionArtifactResult | null = await this.#resolveCommand(command);
		if (replay !== null) return replay;
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO completion_artifact_publish_command (
					organization_id, envelope_id, claim_token, sent_commit_sha, field_generation,
					anchor_audit_event_id, manifest_sha256, json_object_key, json_sha256,
					markdown_object_key, markdown_sha256, updated_at, audit_event_id, audit_sequence,
					previous_audit_hash, audit_event_hash, audit_payload_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.organizationId,
				command.envelopeId,
				command.claimToken,
				command.sentCommitSha,
				command.fieldGeneration,
				command.anchorAuditEventId,
				command.manifestSha256,
				command.jsonObjectKey,
				command.jsonSha256,
				command.markdownObjectKey,
				command.markdownSha256,
				command.updatedAt,
				command.auditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventHash,
				command.auditPayloadJson
			);
		try {
			await this.#database.batch([statement]);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			// The command trigger rolls the INSERT back on a failed predicate, so
			// a caught failure here does not by itself prove which predicate (if
			// any) failed — it could equally be an unrelated transient D1 error.
			// Re-evaluate the exact predicates the trigger checks: only when they
			// prove a real conflict do we classify as stale/integrity; otherwise
			// this was never a predicate failure, and rethrowing the original
			// error lets the service schedule a retry instead of a permanent
			// integrity verdict.
			const classified: PublishCompletionArtifactResult | null =
				await this.#resolveCommand(command);
			if (classified !== null) return classified;
			if (!(await this.#leaseStillValid(command))) return { outcome: 'stale' };
			if (!(await this.#publishPredicatesSatisfied(command))) return { outcome: 'integrity_error' };
			throw error;
		}
	}

	async #leaseStillValid(command: PublishCompletionArtifactCommand): Promise<boolean> {
		const job: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM completion_artifact_job
				 WHERE organization_id = ? AND envelope_id = ? AND status = 'processing'
					AND claim_token = ?`
			)
			.bind(command.organizationId, command.envelopeId, command.claimToken)
			.first<{ ok: number }>();
		return job !== null;
	}

	/** Re-evaluates the same envelope-state, anchor, and no-newer-event predicates the D1 trigger checks. */
	async #publishPredicatesSatisfied(command: PublishCompletionArtifactCommand): Promise<boolean> {
		const envelope: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM envelope
				 WHERE organization_id = ? AND id = ? AND status = 'completed'
					AND sent_commit_sha = ? AND sent_commit_sha = repository_head AND field_generation = ?`
			)
			.bind(
				command.organizationId,
				command.envelopeId,
				command.sentCommitSha,
				command.fieldGeneration
			)
			.first<{ ok: number }>();
		if (envelope === null) return false;

		const anchor: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ? AND id = ? AND sequence = ?
					AND event_hash = ? AND event_type = 'envelope.completed'`
			)
			.bind(
				command.organizationId,
				command.envelopeId,
				command.anchorAuditEventId,
				command.expectedAuditSequence,
				command.previousAuditHash
			)
			.first<{ ok: number }>();
		if (anchor === null) return false;

		const newer: { ok: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS ok FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ? AND sequence >= ?`
			)
			.bind(command.organizationId, command.envelopeId, command.expectedAuditSequence + 1)
			.first<{ ok: number }>();
		return newer === null;
	}

	async failCompletionArtifact(
		command: FailCompletionArtifactCommand
	): Promise<FailCompletionArtifactResult> {
		const result: D1Result = command.retryable
			? await this.#database
					.prepare(
						`UPDATE completion_artifact_job
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 1,
							available_at = ?, last_error = ?, updated_at = ?
						 WHERE organization_id = ? AND envelope_id = ? AND status = 'processing'
							AND claim_token = ?`
					)
					.bind(
						command.nextAvailableAt,
						command.errorCode,
						command.failedAt,
						command.organizationId,
						command.envelopeId,
						command.claimToken
					)
					.run()
			: await this.#database
					.prepare(
						`UPDATE completion_artifact_job
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 0,
							available_at = ?, last_error = ?, updated_at = ?
						 WHERE organization_id = ? AND envelope_id = ? AND status = 'processing'
							AND claim_token = ?`
					)
					.bind(
						command.nextAvailableAt,
						command.errorCode,
						command.failedAt,
						command.organizationId,
						command.envelopeId,
						command.claimToken
					)
					.run();
		return result.meta.changes === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}

	async findCompletionArtifactStatus(
		organizationId: string,
		envelopeId: string
	): Promise<CompletionArtifactStatusRow | null> {
		const row: StatusRow | null = await this.#database
			.prepare(
				`SELECT envelope.id AS envelope_id, envelope.status AS envelope_status,
					job.status AS job_status, job.attempts AS attempts, job.last_error AS last_error,
					job.available_at AS available_at,
					artifact.manifest_sha256 AS artifact_manifest_sha256,
					artifact.json_sha256 AS artifact_json_sha256,
					artifact.markdown_sha256 AS artifact_markdown_sha256,
					artifact.published_at AS artifact_published_at,
					artifact.audit_event_id AS artifact_audit_event_id
				 FROM envelope
				 LEFT JOIN completion_artifact_job job
					ON job.organization_id = envelope.organization_id AND job.envelope_id = envelope.id
				 LEFT JOIN completion_artifact artifact
					ON artifact.organization_id = envelope.organization_id
					AND artifact.envelope_id = envelope.id
				 WHERE envelope.organization_id = ? AND envelope.id = ?`
			)
			.bind(organizationId, envelopeId)
			.first<StatusRow>();
		if (row === null) return null;
		return {
			envelopeId: row.envelope_id,
			envelopeCompleted: row.envelope_status === 'completed',
			jobStatus: row.job_status,
			attempts: row.attempts,
			lastError: row.last_error,
			availableAt: row.available_at,
			published: toPublished(row)
		};
	}

	async #resolveCommand(
		key: PublishCompletionArtifactCommand
	): Promise<PublishCompletionArtifactResult | null> {
		const row: PublishCommandRow | null = await this.#database
			.prepare(
				`SELECT envelope_id, sent_commit_sha, field_generation,
					anchor_audit_event_id, manifest_sha256, json_object_key, json_sha256,
					markdown_object_key, markdown_sha256, updated_at, audit_event_id, audit_sequence,
					previous_audit_hash, audit_event_hash, audit_payload_json
				 FROM completion_artifact_publish_command
				 WHERE organization_id = ? AND envelope_id = ?`
			)
			.bind(key.organizationId, key.envelopeId)
			.first<PublishCommandRow>();
		if (row === null) return null;
		if (!sameEvidence(row, key)) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}
}

function toClaimedJob(row: ClaimCandidateRow): ClaimedCompletionArtifactJob {
	if (row.locked_at === null)
		throw new Error('Claimed completion artifact job is missing its lease');
	if (
		row.sent_commit_sha === null ||
		row.repository_archive_key === null ||
		row.repository_archive_sha256 === null
	) {
		throw new Error('Claimed completion artifact envelope is missing its repository pointer');
	}
	return {
		organizationId: row.organization_id,
		envelopeId: row.envelope_id,
		attempts: row.attempts,
		lockedAt: row.locked_at,
		envelopeTitle: row.envelope_title,
		sentCommitSha: row.sent_commit_sha,
		repositoryArchiveKey: row.repository_archive_key,
		repositoryArchiveSha256: row.repository_archive_sha256,
		fieldGeneration: row.field_generation
	};
}

function toPublished(row: StatusRow): PublishedCompletionArtifact | null {
	if (
		row.artifact_manifest_sha256 === null ||
		row.artifact_json_sha256 === null ||
		row.artifact_markdown_sha256 === null ||
		row.artifact_published_at === null ||
		row.artifact_audit_event_id === null
	) {
		return null;
	}
	return {
		envelopeId: row.envelope_id,
		manifestSha256: row.artifact_manifest_sha256,
		jsonSha256: row.artifact_json_sha256,
		markdownSha256: row.artifact_markdown_sha256,
		publishedAt: row.artifact_published_at,
		auditEventId: row.artifact_audit_event_id
	};
}

function resultFromCommand(command: PublishCompletionArtifactCommand): PublishedCompletionArtifact {
	return {
		envelopeId: command.envelopeId,
		manifestSha256: command.manifestSha256,
		jsonSha256: command.jsonSha256,
		markdownSha256: command.markdownSha256,
		publishedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}

function resultFromRow(row: PublishCommandRow): PublishedCompletionArtifact {
	return {
		envelopeId: row.envelope_id,
		manifestSha256: row.manifest_sha256,
		jsonSha256: row.json_sha256,
		markdownSha256: row.markdown_sha256,
		publishedAt: row.updated_at,
		auditEventId: row.audit_event_id
	};
}

function sameEvidence(row: PublishCommandRow, key: PublishCompletionArtifactCommand): boolean {
	return (
		row.sent_commit_sha === key.sentCommitSha &&
		row.field_generation === key.fieldGeneration &&
		row.anchor_audit_event_id === key.anchorAuditEventId &&
		row.audit_sequence === key.expectedAuditSequence + 1 &&
		row.previous_audit_hash === key.previousAuditHash &&
		row.manifest_sha256 === key.manifestSha256 &&
		row.json_object_key === key.jsonObjectKey &&
		row.json_sha256 === key.jsonSha256 &&
		row.markdown_object_key === key.markdownObjectKey &&
		row.markdown_sha256 === key.markdownSha256 &&
		row.audit_event_id === key.auditEventId &&
		row.audit_event_hash === key.auditEventHash &&
		row.audit_payload_json === key.auditPayloadJson
	);
}
