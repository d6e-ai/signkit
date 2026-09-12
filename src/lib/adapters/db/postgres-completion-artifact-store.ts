import postgres from 'postgres';
import type { FieldType, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
import {
	CompletionArtifactIntegrityError,
	MAX_COMPLETION_AUDIT_VERIFY_EVENTS,
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

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class CompletionArtifactPublishIntegrityError extends Error {
	constructor() {
		super('Completion artifact publication integrity check failed');
		this.name = 'CompletionArtifactPublishIntegrityError';
	}
}

interface ClaimCandidateRow {
	organizationId: string;
	envelopeId: string;
	attempts: number | string;
	lockedAt: Date | string | null;
	envelopeTitle: string;
	sentCommitSha: string | null;
	repositoryArchiveKey: string | null;
	repositoryArchiveSha256: string | null;
	fieldGeneration: number;
}

interface RecipientEvidenceRow {
	id: string;
	role: RecipientRole;
	routingOrder: number;
	status: RecipientStatus;
	decisionEventId: string | null;
	decisionOccurredAt: Date | string | null;
}

interface FieldEvidenceRow {
	fieldId: string;
	fieldType: FieldType;
	valueJson: string;
	valueSha256: string;
}

interface AuditEvidenceRow {
	id: string;
	sequence: number | string;
	eventType: string;
	actorType: string;
	actorId: string | null;
	payloadJson: string;
	previousHash: string | null;
	eventHash: string;
	/** `to_char(... , 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`: full microsecond precision, so alteration below millisecond precision cannot hide behind the driver's own millisecond-only `Date` rounding. */
	occurredAtPrecise: string;
}

interface EnvelopeLockRow {
	status: string;
	sentCommitSha: string | null;
	repositoryHead: string | null;
	fieldGeneration: number;
}

interface JobLockRow {
	status: string;
	claimToken: string | null;
}

interface AnchorRow {
	sequence: number | string;
	eventHash: string;
	eventType: string;
}

interface PublishCommandRow {
	envelopeId: string;
	sentCommitSha: string;
	fieldGeneration: number;
	anchorAuditEventId: string;
	manifestSha256: string;
	jsonObjectKey: string;
	jsonSha256: string;
	markdownObjectKey: string;
	markdownSha256: string;
	updatedAt: Date | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export class PostgresCompletionArtifactStore implements CompletionArtifactStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async claimPendingCompletionArtifacts(
		command: ClaimCompletionArtifactsCommand
	): Promise<readonly ClaimedCompletionArtifactJob[]> {
		return await this.#sql.begin(
			async (transaction): Promise<readonly ClaimedCompletionArtifactJob[]> => {
				await transaction`
					INSERT INTO completion_artifact_job (
						organization_id, envelope_id, status, attempts, available_at, retryable,
						created_at, updated_at
					)
					SELECT envelope.organization_id, envelope.id, 'pending', 0,
						${command.claimedAt}::timestamptz, true,
						${command.claimedAt}::timestamptz, ${command.claimedAt}::timestamptz
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
					LIMIT ${command.discoveryLimit}
					ON CONFLICT (organization_id, envelope_id) DO NOTHING`;

				const candidates = await transaction<ClaimCandidateRow[]>`
					SELECT job.organization_id AS "organizationId", job.envelope_id AS "envelopeId",
						job.attempts AS attempts, job.locked_at AS "lockedAt",
						envelope.title AS "envelopeTitle",
						envelope.sent_commit_sha AS "sentCommitSha",
						envelope.repository_archive_key AS "repositoryArchiveKey",
						envelope.repository_archive_sha256 AS "repositoryArchiveSha256",
						envelope.field_generation AS "fieldGeneration"
					FROM completion_artifact_job job
					INNER JOIN envelope
						ON envelope.organization_id = job.organization_id
						AND envelope.id = job.envelope_id
					WHERE (
							(job.status IN ('pending', 'failed') AND job.retryable
								AND job.available_at <= ${command.claimedAt}::timestamptz)
							OR (job.status = 'processing'
								AND job.locked_at < ${command.staleBefore}::timestamptz)
						)
						AND envelope.status = 'completed'
					ORDER BY job.available_at ASC, job.envelope_id ASC
					LIMIT ${command.claimLimit}
					FOR UPDATE OF job SKIP LOCKED`;
				if (candidates.length === 0) return [];

				const claimed: ClaimedCompletionArtifactJob[] = [];
				for (const row of candidates) {
					const updated = await transaction<{ envelope_id: string }[]>`
						UPDATE completion_artifact_job
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}::timestamptz, attempts = attempts + 1,
							updated_at = ${command.claimedAt}::timestamptz
						WHERE organization_id = ${row.organizationId} AND envelope_id = ${row.envelopeId}
							AND (
								(status IN ('pending', 'failed') AND retryable
									AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing'
									AND locked_at < ${command.staleBefore}::timestamptz)
							)
						RETURNING envelope_id`;
					if (updated.length === 1) {
						claimed.push(toClaimedJob(row, command.claimedAt, 1));
					}
				}
				return claimed;
			}
		);
	}

	async readClaimedCompletionArtifact(
		command: ReadClaimedCompletionArtifactCommand
	): Promise<ClaimedCompletionArtifactJob | null> {
		const rows = await this.#sql<ClaimCandidateRow[]>`
			SELECT job.organization_id AS "organizationId", job.envelope_id AS "envelopeId",
				job.attempts AS attempts, job.locked_at AS "lockedAt",
				envelope.title AS "envelopeTitle", envelope.sent_commit_sha AS "sentCommitSha",
				envelope.repository_archive_key AS "repositoryArchiveKey",
				envelope.repository_archive_sha256 AS "repositoryArchiveSha256",
				envelope.field_generation AS "fieldGeneration"
			FROM completion_artifact_job job
			INNER JOIN envelope
				ON envelope.organization_id = job.organization_id AND envelope.id = job.envelope_id
			WHERE job.organization_id = ${command.organizationId}
				AND job.envelope_id = ${command.envelopeId}
				AND job.status = 'processing' AND job.claim_token = ${command.claimToken}`;
		const row: ClaimCandidateRow | undefined = rows[0];
		if (row === undefined) return null;
		const lockedAt: string | null = isoTimestampOrNull(row.lockedAt);
		if (lockedAt === null) {
			throw new Error('Claimed completion artifact job is missing its lease');
		}
		return toClaimedJob(row, lockedAt, 0);
	}

	async readCompletionEvidence(
		organizationId: string,
		envelopeId: string
	): Promise<CompletionEvidence> {
		const recipients = await this.#sql<RecipientEvidenceRow[]>`
			SELECT recipient.id, recipient.role, recipient.routing_order AS "routingOrder",
				recipient.status,
				(SELECT decision.id FROM audit_event decision
					WHERE decision.organization_id = recipient.organization_id
						AND decision.envelope_id = recipient.envelope_id
						AND decision.actor_id = recipient.id
						AND decision.event_type IN ('recipient.signed', 'recipient.approved')
					ORDER BY decision.sequence ASC LIMIT 1) AS "decisionEventId",
				(SELECT decision.occurred_at FROM audit_event decision
					WHERE decision.organization_id = recipient.organization_id
						AND decision.envelope_id = recipient.envelope_id
						AND decision.actor_id = recipient.id
						AND decision.event_type IN ('recipient.signed', 'recipient.approved')
					ORDER BY decision.sequence ASC LIMIT 1) AS "decisionOccurredAt"
			FROM recipient
			WHERE recipient.organization_id = ${organizationId}
				AND recipient.envelope_id = ${envelopeId}
			ORDER BY recipient.id`;
		const fields = await this.#sql<FieldEvidenceRow[]>`
			SELECT field_id AS "fieldId", field_type AS "fieldType", value_json AS "valueJson",
				value_sha256 AS "valueSha256"
			FROM field_value
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY field_id`;
		const auditEvents = await this.#sql<AuditEvidenceRow[]>`
			SELECT id, sequence, event_type AS "eventType", actor_type AS "actorType",
				actor_id AS "actorId", payload_json AS "payloadJson", previous_hash AS "previousHash",
				event_hash AS "eventHash",
				to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAtPrecise"
			FROM audit_event
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY sequence ASC
			LIMIT ${MAX_COMPLETION_AUDIT_VERIFY_EVENTS + 1}`;

		return {
			recipients: recipients.map((row: RecipientEvidenceRow): CompletionEvidenceRecipient => ({
				id: row.id,
				role: row.role,
				routingOrder: row.routingOrder,
				status: row.status,
				decisionEventId: row.decisionEventId,
				decisionOccurredAt: isoTimestampOrNull(row.decisionOccurredAt)
			})),
			fields: fields.map((row: FieldEvidenceRow): CompletionEvidenceField => ({
				id: row.fieldId,
				fieldType: row.fieldType,
				valueJson: row.valueJson,
				valueSha256: row.valueSha256
			})),
			auditEvents: auditEvents.map((row: AuditEvidenceRow): CompletionEvidenceAuditEvent => ({
				id: row.id,
				sequence: Number(row.sequence),
				eventType: row.eventType,
				actorType: row.actorType,
				actorId: row.actorId,
				payloadJson: row.payloadJson,
				previousHash: row.previousHash,
				eventHash: row.eventHash,
				occurredAt: alignedMillisecondTimestamp(row.occurredAtPrecise)
			}))
		};
	}

	async publishCompletionArtifact(
		command: PublishCompletionArtifactCommand
	): Promise<PublishCompletionArtifactResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<PublishCompletionArtifactResult> => {
					const envelopeRows = await transaction<EnvelopeLockRow[]>`
						SELECT status, sent_commit_sha AS "sentCommitSha",
							repository_head AS "repositoryHead", field_generation AS "fieldGeneration"
						FROM envelope
						WHERE organization_id = ${command.organizationId} AND id = ${command.envelopeId}
						FOR UPDATE`;
					const jobRows = await transaction<JobLockRow[]>`
						SELECT status, claim_token AS "claimToken" FROM completion_artifact_job
						WHERE organization_id = ${command.organizationId}
							AND envelope_id = ${command.envelopeId}
						FOR UPDATE`;

					const replay: PublishCompletionArtifactResult | null = await this.#resolveCommand(
						transaction,
						command
					);
					if (replay !== null) return replay;

					const envelope: EnvelopeLockRow | undefined = envelopeRows[0];
					if (
						envelope === undefined ||
						envelope.status !== 'completed' ||
						envelope.sentCommitSha !== command.sentCommitSha ||
						envelope.repositoryHead !== command.sentCommitSha ||
						envelope.fieldGeneration !== command.fieldGeneration
					) {
						return { outcome: 'integrity_error' };
					}

					const anchorRows = await transaction<AnchorRow[]>`
						SELECT sequence, event_hash AS "eventHash", event_type AS "eventType"
						FROM audit_event
						WHERE organization_id = ${command.organizationId}
							AND envelope_id = ${command.envelopeId}
							AND id = ${command.anchorAuditEventId}`;
					const anchor: AnchorRow | undefined = anchorRows[0];
					if (
						anchor === undefined ||
						anchor.eventType !== 'envelope.completed' ||
						Number(anchor.sequence) !== command.expectedAuditSequence ||
						anchor.eventHash !== command.previousAuditHash
					) {
						return { outcome: 'integrity_error' };
					}
					const newerRows = await transaction<{ sequence: number }[]>`
						SELECT sequence FROM audit_event
						WHERE organization_id = ${command.organizationId}
							AND envelope_id = ${command.envelopeId}
							AND sequence >= ${command.expectedAuditSequence + 1}
						LIMIT 1`;
					if (newerRows.length > 0) return { outcome: 'integrity_error' };

					const job: JobLockRow | undefined = jobRows[0];
					if (
						job === undefined ||
						job.status !== 'processing' ||
						job.claimToken !== command.claimToken
					) {
						return { outcome: 'stale' };
					}

					await transaction`
						INSERT INTO completion_artifact (
							organization_id, envelope_id, schema_version, manifest_sha256,
							json_object_key, json_sha256, markdown_object_key, markdown_sha256,
							sent_commit_sha, field_generation, anchor_audit_event_id,
							audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
						) VALUES (
							${command.organizationId}, ${command.envelopeId}, 1, ${command.manifestSha256},
							${command.jsonObjectKey}, ${command.jsonSha256}, ${command.markdownObjectKey},
							${command.markdownSha256}, ${command.sentCommitSha}, ${command.fieldGeneration},
							${command.anchorAuditEventId}, ${command.expectedAuditSequence + 1},
							${command.auditEventHash}, ${command.updatedAt}::timestamptz, ${command.auditEventId}
						)`;
					const updatedJob = await transaction<{ envelope_id: string }[]>`
						UPDATE completion_artifact_job
						SET status = 'published', claim_token = NULL, locked_at = NULL, retryable = false,
							updated_at = ${command.updatedAt}::timestamptz
						WHERE organization_id = ${command.organizationId}
							AND envelope_id = ${command.envelopeId}
							AND status = 'processing' AND claim_token = ${command.claimToken}
						RETURNING envelope_id`;
					if (updatedJob.length !== 1) throw new CompletionArtifactPublishIntegrityError();
					await transaction`
						INSERT INTO audit_event (
							id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
							payload_json, previous_hash, event_hash, occurred_at
						) VALUES (
							${command.auditEventId}, ${command.organizationId}, ${command.envelopeId},
							${command.expectedAuditSequence + 1}, 'envelope.completion_artifact_published',
							'system', 'completion-artifact-worker', ${command.auditPayloadJson},
							${command.previousAuditHash}, ${command.auditEventHash},
							${command.updatedAt}::timestamptz
						)`;
					await transaction`
						INSERT INTO completion_artifact_publish_command (
							organization_id, envelope_id, claim_token, sent_commit_sha, field_generation,
							anchor_audit_event_id, manifest_sha256, json_object_key, json_sha256,
							markdown_object_key, markdown_sha256, updated_at, audit_event_id,
							audit_sequence, previous_audit_hash, audit_event_hash, audit_payload_json
						) VALUES (
							${command.organizationId}, ${command.envelopeId}, ${command.claimToken},
							${command.sentCommitSha}, ${command.fieldGeneration},
							${command.anchorAuditEventId}, ${command.manifestSha256},
							${command.jsonObjectKey}, ${command.jsonSha256}, ${command.markdownObjectKey},
							${command.markdownSha256}, ${command.updatedAt}::timestamptz,
							${command.auditEventId}, ${command.expectedAuditSequence + 1},
							${command.previousAuditHash}, ${command.auditEventHash},
							${command.auditPayloadJson}
						)`;
					return { outcome: 'published', result: resultFromCommand(command) };
				}
			);
		} catch (error: unknown) {
			const classified: PublishCompletionArtifactResult | null = await this.#resolveCommand(
				this.#sql,
				command
			);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async failCompletionArtifact(
		command: FailCompletionArtifactCommand
	): Promise<FailCompletionArtifactResult> {
		const rows = command.retryable
			? await this.#sql<{ envelope_id: string }[]>`
					UPDATE completion_artifact_job
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = true,
						available_at = ${command.nextAvailableAt}, last_error = ${command.errorCode},
						updated_at = ${command.failedAt}
					WHERE organization_id = ${command.organizationId}
						AND envelope_id = ${command.envelopeId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING envelope_id`
			: await this.#sql<{ envelope_id: string }[]>`
					UPDATE completion_artifact_job
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
						available_at = ${command.nextAvailableAt}, last_error = ${command.errorCode},
						updated_at = ${command.failedAt}
					WHERE organization_id = ${command.organizationId}
						AND envelope_id = ${command.envelopeId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING envelope_id`;
		return rows.length === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}

	async findCompletionArtifactStatus(
		organizationId: string,
		envelopeId: string
	): Promise<CompletionArtifactStatusRow | null> {
		const rows = await this.#sql<
			{
				envelopeId: string;
				envelopeStatus: string;
				jobStatus: 'pending' | 'processing' | 'published' | 'failed' | null;
				attempts: number | string | null;
				lastError: string | null;
				availableAt: Date | string | null;
				manifestSha256: string | null;
				jsonSha256: string | null;
				markdownSha256: string | null;
				publishedAt: Date | string | null;
				auditEventId: string | null;
			}[]
		>`
			SELECT envelope.id AS "envelopeId", envelope.status AS "envelopeStatus",
				job.status AS "jobStatus", job.attempts AS attempts,
				job.last_error AS "lastError", job.available_at AS "availableAt",
				artifact.manifest_sha256 AS "manifestSha256", artifact.json_sha256 AS "jsonSha256",
				artifact.markdown_sha256 AS "markdownSha256", artifact.published_at AS "publishedAt",
				artifact.audit_event_id AS "auditEventId"
			FROM envelope
			LEFT JOIN completion_artifact_job job
				ON job.organization_id = envelope.organization_id AND job.envelope_id = envelope.id
			LEFT JOIN completion_artifact artifact
				ON artifact.organization_id = envelope.organization_id
				AND artifact.envelope_id = envelope.id
			WHERE envelope.organization_id = ${organizationId} AND envelope.id = ${envelopeId}`;
		const row = rows[0];
		if (row === undefined) return null;
		const published: PublishedCompletionArtifact | null =
			row.manifestSha256 === null ||
			row.jsonSha256 === null ||
			row.markdownSha256 === null ||
			row.publishedAt === null ||
			row.auditEventId === null
				? null
				: {
						envelopeId: row.envelopeId,
						manifestSha256: row.manifestSha256,
						jsonSha256: row.jsonSha256,
						markdownSha256: row.markdownSha256,
						publishedAt: isoTimestampOrNull(row.publishedAt) as string,
						auditEventId: row.auditEventId
					};
		return {
			envelopeId: row.envelopeId,
			envelopeCompleted: row.envelopeStatus === 'completed',
			jobStatus: row.jobStatus,
			attempts: row.attempts === null ? null : Number(row.attempts),
			lastError: row.lastError,
			availableAt: isoTimestampOrNull(row.availableAt),
			published
		};
	}

	async #resolveCommand(
		sql: Sql,
		key: PublishCompletionArtifactCommand
	): Promise<PublishCompletionArtifactResult | null> {
		const rows = await sql<PublishCommandRow[]>`
			SELECT envelope_id AS "envelopeId", sent_commit_sha AS "sentCommitSha",
				field_generation AS "fieldGeneration", anchor_audit_event_id AS "anchorAuditEventId",
				manifest_sha256 AS "manifestSha256", json_object_key AS "jsonObjectKey",
				json_sha256 AS "jsonSha256", markdown_object_key AS "markdownObjectKey",
				markdown_sha256 AS "markdownSha256", updated_at AS "updatedAt",
				audit_event_id AS "auditEventId", audit_sequence AS "auditSequence",
				previous_audit_hash AS "previousAuditHash", audit_event_hash AS "auditEventHash",
				audit_payload_json AS "auditPayloadJson"
			FROM completion_artifact_publish_command
			WHERE organization_id = ${key.organizationId} AND envelope_id = ${key.envelopeId}`;
		const row: PublishCommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (!sameEvidence(row, key)) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}
}

function toClaimedJob(
	row: ClaimCandidateRow,
	lockedAt: string,
	attemptIncrement: number
): ClaimedCompletionArtifactJob {
	if (
		row.sentCommitSha === null ||
		row.repositoryArchiveKey === null ||
		row.repositoryArchiveSha256 === null
	) {
		throw new Error('Claimed completion artifact envelope is missing its repository pointer');
	}
	return {
		organizationId: row.organizationId,
		envelopeId: row.envelopeId,
		attempts: Number(row.attempts) + attemptIncrement,
		lockedAt,
		envelopeTitle: row.envelopeTitle,
		sentCommitSha: row.sentCommitSha,
		repositoryArchiveKey: row.repositoryArchiveKey,
		repositoryArchiveSha256: row.repositoryArchiveSha256,
		fieldGeneration: row.fieldGeneration
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
		envelopeId: row.envelopeId,
		manifestSha256: row.manifestSha256,
		jsonSha256: row.jsonSha256,
		markdownSha256: row.markdownSha256,
		publishedAt: isoTimestampOrNull(row.updatedAt) as string,
		auditEventId: row.auditEventId
	};
}

function sameEvidence(row: PublishCommandRow, key: PublishCompletionArtifactCommand): boolean {
	return (
		row.sentCommitSha === key.sentCommitSha &&
		row.fieldGeneration === key.fieldGeneration &&
		row.anchorAuditEventId === key.anchorAuditEventId &&
		Number(row.auditSequence) === key.expectedAuditSequence + 1 &&
		row.previousAuditHash === key.previousAuditHash &&
		row.manifestSha256 === key.manifestSha256 &&
		row.jsonObjectKey === key.jsonObjectKey &&
		row.jsonSha256 === key.jsonSha256 &&
		row.markdownObjectKey === key.markdownObjectKey &&
		row.markdownSha256 === key.markdownSha256 &&
		row.auditEventId === key.auditEventId &&
		row.auditEventHash === key.auditEventHash &&
		row.auditPayloadJson === key.auditPayloadJson
	);
}

function isoTimestampOrNull(value: Date | string | null): string | null {
	if (value === null) return null;
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const POSTGRES_MICROSECOND_TIMESTAMP_PATTERN: RegExp =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/;

/**
 * The `postgres` driver's default `timestamptz` -> `Date` conversion is
 * millisecond precision, so any sub-millisecond alteration to a stored
 * `occurred_at` would otherwise be silently rounded away and never seen by
 * the hash recompute — a value could be tampered with just enough to matter
 * while still passing a naive read. Reading with explicit microsecond
 * precision and requiring the sub-millisecond remainder to be exactly zero
 * (every writer only ever produces millisecond-precision timestamps) turns
 * that silent rounding into a fail-closed check.
 */
function alignedMillisecondTimestamp(precise: string): string {
	const match: RegExpExecArray | null = POSTGRES_MICROSECOND_TIMESTAMP_PATTERN.exec(precise);
	if (match === null) {
		throw new CompletionArtifactIntegrityError(
			'Audit event timestamp could not be read at microsecond precision'
		);
	}
	const [, dateTime, microseconds] = match;
	if (microseconds.slice(3) !== '000') {
		throw new CompletionArtifactIntegrityError(
			'Audit event timestamp has been altered below millisecond precision'
		);
	}
	return `${dateTime}.${microseconds.slice(0, 3)}Z`;
}
