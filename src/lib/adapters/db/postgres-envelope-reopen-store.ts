import postgres from 'postgres';
import { validStoredReopenReceipt } from '$lib/domain/commands/reopen';
import type { Envelope } from '$lib/domain/envelope';
import type {
	EnvelopeReopenStore,
	PublishReopenedEnvelopeCommand,
	PublishReopenedEnvelopeResult,
	PublishedReopenedEnvelope,
	ReopenAuditHead,
	ReopenCommandKey,
	ReopenPreparation
} from '$lib/ports/envelope-reopen-store';
import { PostgresEnvelopeStore } from './postgres-envelope-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

interface ReopenCommandRow {
	envelopeId: string;
	actorType: string;
	actorId: string;
	requestHash: string;
	expectedGeneration: number;
	expectedFieldGeneration: number;
	readyAuditEventId: string;
	commitSha: string;
	updatedAt: Date | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
	evidenceEventId: string | null;
	evidenceEnvelopeId: string | null;
	evidenceSequence: number | string | null;
	evidenceEventType: string | null;
	evidenceActorType: string | null;
	evidenceActorId: string | null;
	evidencePayloadJson: string | null;
	evidencePreviousHash: string | null;
	evidenceEventHash: string | null;
	evidenceOccurredAt: Date | string | null;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface ReadyAuditAnchorRow {
	sequence: number | string;
}

export class PostgresEnvelopeReopenStore implements EnvelopeReopenStore {
	readonly #sql: ReturnType<typeof postgres>;
	readonly #envelopes: PostgresEnvelopeStore;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
		this.#envelopes = new PostgresEnvelopeStore(sql);
	}

	async prepareReopen(
		key: ReopenCommandKey,
		expectedGeneration: number,
		expectedFieldGeneration: number,
		expectedReadyAuditEventId: string
	): Promise<ReopenPreparation> {
		const replay: ReopenPreparation | null = await this.#resolveCommand(this.#sql, key);
		if (replay !== null) return replay;
		const envelope: Envelope | null = await this.#envelopes.findEnvelope(key.envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'ready') return { outcome: 'not_ready' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		if (envelope.fieldGeneration !== expectedFieldGeneration) {
			return { outcome: 'field_generation_conflict' };
		}
		if (envelope.repositoryHead === null || envelope.sentCommitSha !== null) {
			return { outcome: 'integrity_error' };
		}
		const auditHead: ReopenAuditHead | null = await this.#readAuditHead(this.#sql, key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const readyAuditSequence: number | null = await this.#readLatestReadyAuditSequence(
			this.#sql,
			key.envelopeId,
			expectedGeneration,
			envelope.repositoryHead,
			expectedReadyAuditEventId
		);
		if (readyAuditSequence === null || readyAuditSequence > auditHead.sequence) {
			return { outcome: 'audit_conflict' };
		}
		return { outcome: 'ready', envelope, auditHead };
	}

	async publishReopen(
		command: PublishReopenedEnvelopeCommand
	): Promise<PublishReopenedEnvelopeResult> {
		const replay: ReopenPreparation | null = await this.#resolveCommand(this.#sql, command);
		if (replay !== null) return publishFromPreparation(replay);

		try {
			return await this.#sql.begin(async (transaction): Promise<PublishReopenedEnvelopeResult> => {
				const lockedRows = await transaction<
					{
						status: string;
						repositoryGeneration: number;
						repositoryHead: string | null;
						fieldGeneration: number;
						sentCommitSha: string | null;
					}[]
				>`
					SELECT status, repository_generation AS "repositoryGeneration",
						repository_head AS "repositoryHead", field_generation AS "fieldGeneration",
						sent_commit_sha AS "sentCommitSha"
					FROM envelope
					WHERE id = ${command.envelopeId}
					FOR UPDATE
				`;
				if (lockedRows.length === 0) return { outcome: 'not_found' };

				const raced: ReopenPreparation | null = await this.#resolveCommand(transaction, command);
				if (raced !== null) return publishFromPreparation(raced);

				const locked = lockedRows[0];
				if (locked.status !== 'ready') return { outcome: 'not_ready' };
				if (locked.repositoryGeneration !== command.expectedGeneration) {
					return { outcome: 'generation_conflict' };
				}
				if (locked.fieldGeneration !== command.expectedFieldGeneration) {
					return { outcome: 'field_generation_conflict' };
				}
				if (locked.repositoryHead === null || locked.sentCommitSha !== null) {
					return { outcome: 'integrity_error' };
				}
				if (locked.repositoryHead !== command.expectedCommitSha) {
					return { outcome: 'integrity_error' };
				}

				const auditHead: ReopenAuditHead | null = await this.#readAuditHead(
					transaction,
					command.envelopeId
				);
				if (auditHead === null) return { outcome: 'integrity_error' };
				if (
					auditHead.sequence !== command.expectedAuditSequence ||
					auditHead.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'audit_conflict' };
				}
				const readyAuditSequence: number | null = await this.#readLatestReadyAuditSequence(
					transaction,
					command.envelopeId,
					command.expectedGeneration,
					command.expectedCommitSha,
					command.expectedReadyAuditEventId
				);
				if (readyAuditSequence === null || readyAuditSequence > auditHead.sequence) {
					return { outcome: 'audit_conflict' };
				}

				const updatedRows = await transaction<{ id: string }[]>`
					UPDATE envelope
					SET status = 'draft',
						field_generation = ${command.expectedFieldGeneration + 1},
						updated_at = ${command.updatedAt}
					WHERE id = ${command.envelopeId}
						AND status = 'ready'
						AND sent_commit_sha IS NULL
						AND repository_generation = ${command.expectedGeneration}
						AND repository_head = ${command.expectedCommitSha}
						AND field_generation = ${command.expectedFieldGeneration}
					RETURNING id
				`;
				if (updatedRows.length !== 1) return { outcome: 'generation_conflict' };

				await transaction`
					INSERT INTO envelope_reopen_command (
						envelope_id, actor_type, actor_id, idempotency_key, request_hash,
						expected_generation, expected_field_generation, ready_audit_event_id, commit_sha,
						updated_at, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json
					) VALUES (
						${command.envelopeId}, ${command.actorType}, ${command.actorId},
						${command.idempotencyKey}, ${command.requestFingerprint},
						${command.expectedGeneration}, ${command.expectedFieldGeneration},
						${command.expectedReadyAuditEventId}, ${command.expectedCommitSha},
						${command.updatedAt}, ${command.auditEventId},
						${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.auditPayloadJson}
					)
				`;

				await transaction`
					DELETE FROM envelope_field
					WHERE envelope_id = ${command.envelopeId}
				`;

				await transaction`
					INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type,
						actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
					) VALUES (
						${command.auditEventId}, ${command.envelopeId},
						${command.expectedAuditSequence + 1}, 'envelope.reopened', ${command.actorType},
						${command.actorId}, ${command.auditPayloadJson}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.updatedAt}, 3
					)
				`;

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: ReopenPreparation = await this.prepareReopen(
				command,
				command.expectedGeneration,
				command.expectedFieldGeneration,
				command.expectedReadyAuditEventId
			);
			if (classified.outcome !== 'ready') return publishFromPreparation(classified);
			throw error;
		}
	}

	async #resolveCommand(sql: Sql, key: ReopenCommandKey): Promise<ReopenPreparation | null> {
		const rows = await sql<ReopenCommandRow[]>`
			SELECT
				command.envelope_id AS "envelopeId", command.actor_type AS "actorType",
				command.actor_id AS "actorId",
				command.request_hash AS "requestHash",
				command.expected_generation AS "expectedGeneration",
				command.expected_field_generation AS "expectedFieldGeneration",
				command.ready_audit_event_id AS "readyAuditEventId",
				command.commit_sha AS "commitSha", command.updated_at AS "updatedAt",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash",
				command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson",
				evidence.id AS "evidenceEventId",
				evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence",
				evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType",
				evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson",
				evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash",
				evidence.occurred_at AS "evidenceOccurredAt"
			FROM envelope_reopen_command command
			LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			WHERE command.actor_type = ${key.actorType}
				AND command.actor_id = ${key.actorId}
				AND command.idempotency_key = ${key.idempotencyKey}
			LIMIT 1
		`;
		const row: ReopenCommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (row.envelopeId !== key.envelopeId || row.requestHash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!validAuditEvidence(row)) return { outcome: 'integrity_error' };
		if (!(await validStoredReceipt(row))) return { outcome: 'integrity_error' };
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelopeId,
				status: 'draft',
				generation: row.expectedGeneration,
				fieldGeneration: row.expectedFieldGeneration + 1,
				updatedAt: isoTimestamp(row.updatedAt),
				auditEventId: row.auditEventId
			}
		};
	}

	async #readAuditHead(sql: Sql, envelopeId: string): Promise<ReopenAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash"
			FROM audit_event
			WHERE envelope_id = ${envelopeId}
			ORDER BY sequence DESC LIMIT 1
		`;
		const row: AuditHeadRow | undefined = rows[0];
		if (row === undefined) return null;
		const sequence: number = typeof row.sequence === 'number' ? row.sequence : Number(row.sequence);
		if (!Number.isSafeInteger(sequence) || sequence < 1 || row.eventHash.length === 0) return null;
		return { sequence, eventHash: row.eventHash };
	}

	async #readLatestReadyAuditSequence(
		sql: Sql,
		envelopeId: string,
		expectedGeneration: number,
		expectedCommitSha: string,
		expectedReadyAuditEventId: string
	): Promise<number | null> {
		const rows = await sql<ReadyAuditAnchorRow[]>`
			SELECT ready.audit_sequence AS sequence
			FROM envelope_ready_command ready
			JOIN audit_event evidence
				ON evidence.envelope_id = ready.envelope_id
				AND evidence.id = ready.audit_event_id
				AND evidence.sequence = ready.audit_sequence
				AND evidence.event_type = 'envelope.ready'
			WHERE ready.envelope_id = ${envelopeId}
				AND ready.expected_generation = ${expectedGeneration}
				AND ready.commit_sha = ${expectedCommitSha}
				AND ready.audit_event_id = ${expectedReadyAuditEventId}
				AND NOT EXISTS (
					SELECT 1 FROM audit_event later
					WHERE later.envelope_id = ready.envelope_id
						AND later.sequence > ready.audit_sequence
						AND later.event_type IN ('envelope.ready', 'envelope.reopened')
				)
			LIMIT 1
		`;
		const row: ReadyAuditAnchorRow | undefined = rows[0];
		if (row === undefined) return null;
		const sequence: number = typeof row.sequence === 'number' ? row.sequence : Number(row.sequence);
		return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
	}
}

function validAuditEvidence(row: ReopenCommandRow): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'envelope.reopened' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt)
	);
}

async function validStoredReceipt(row: ReopenCommandRow): Promise<boolean> {
	return validStoredReopenReceipt({
		envelopeId: row.envelopeId,
		expectedGeneration: row.expectedGeneration,
		expectedFieldGeneration: row.expectedFieldGeneration,
		readyAuditEventId: row.readyAuditEventId,
		commitSha: row.commitSha,
		requestHash: row.requestHash,
		auditPayloadJson: row.auditPayloadJson
	});
}

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sameTimestamp(left: Date | string | null, right: Date | string): boolean {
	if (left === null) return false;
	return isoTimestamp(left) === isoTimestamp(right);
}

function resultFromCommand(command: PublishReopenedEnvelopeCommand): PublishedReopenedEnvelope {
	return {
		envelopeId: command.envelopeId,
		status: 'draft',
		generation: command.expectedGeneration,
		fieldGeneration: command.expectedFieldGeneration + 1,
		updatedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}

function publishFromPreparation(preparation: ReopenPreparation): PublishReopenedEnvelopeResult {
	if (preparation.outcome === 'replayed') return preparation;
	if (preparation.outcome === 'idempotency_conflict') return preparation;
	if (preparation.outcome === 'not_found') return preparation;
	if (preparation.outcome === 'not_ready') return preparation;
	if (preparation.outcome === 'generation_conflict') return preparation;
	if (preparation.outcome === 'field_generation_conflict') return preparation;
	if (preparation.outcome === 'audit_conflict') return preparation;
	return { outcome: 'integrity_error' };
}
