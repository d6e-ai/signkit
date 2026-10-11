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
import { D1EnvelopeStore } from './d1-envelope-store';

interface ReopenCommandRow {
	envelope_id: string;
	actor_type: string;
	actor_id: string;
	request_hash: string;
	expected_generation: number;
	expected_field_generation: number;
	ready_audit_event_id: string;
	commit_sha: string;
	updated_at: string;
	audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
	evidence_event_id: string | null;
	evidence_envelope_id: string | null;
	evidence_sequence: number | null;
	evidence_event_type: string | null;
	evidence_actor_type: string | null;
	evidence_actor_id: string | null;
	evidence_payload_json: string | null;
	evidence_previous_hash: string | null;
	evidence_event_hash: string | null;
	evidence_occurred_at: string | null;
}

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

interface ReadyAuditAnchorRow {
	sequence: number;
}

export class D1EnvelopeReopenStore implements EnvelopeReopenStore {
	readonly #database: D1Database;
	readonly #envelopes: D1EnvelopeStore;

	constructor(database: D1Database) {
		this.#database = database;
		this.#envelopes = new D1EnvelopeStore(database);
	}

	async prepareReopen(
		key: ReopenCommandKey,
		expectedGeneration: number,
		expectedFieldGeneration: number,
		expectedReadyAuditEventId: string
	): Promise<ReopenPreparation> {
		const replay: ReopenPreparation | null = await this.#resolveCommand(key);
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
		const auditHead: ReopenAuditHead | null = await this.#readAuditHead(key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const readyAuditSequence: number | null = await this.#readLatestReadyAuditSequence(
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
		const replay: ReopenPreparation | null = await this.#resolveCommand(command);
		if (replay !== null) return publishFromPreparation(replay);

		try {
			await this.#database
				.prepare(
					`INSERT INTO envelope_reopen_command (
						envelope_id, actor_type, actor_id, idempotency_key, request_hash,
						expected_generation, expected_field_generation, ready_audit_event_id, commit_sha,
						updated_at, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					command.envelopeId,
					command.actorType,
					command.actorId,
					command.idempotencyKey,
					command.requestFingerprint,
					command.expectedGeneration,
					command.expectedFieldGeneration,
					command.expectedReadyAuditEventId,
					command.expectedCommitSha,
					command.updatedAt,
					command.auditEventId,
					command.expectedAuditSequence + 1,
					command.previousAuditHash,
					command.auditEventHash,
					command.auditPayloadJson
				)
				.run();
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			const raced: ReopenPreparation | null = await this.#resolveCommand(command);
			if (raced !== null) return publishFromPreparation(raced);
			const classified: PublishReopenedEnvelopeResult | null = await this.#classifyFailure(command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async #resolveCommand(key: ReopenCommandKey): Promise<ReopenPreparation | null> {
		const row: ReopenCommandRow | null = await this.#database
			.prepare(
				`SELECT command.*,
					evidence.id AS evidence_event_id,
					evidence.envelope_id AS evidence_envelope_id,
					evidence.sequence AS evidence_sequence,
					evidence.event_type AS evidence_event_type,
					evidence.actor_type AS evidence_actor_type,
					evidence.actor_id AS evidence_actor_id,
					evidence.payload_json AS evidence_payload_json,
					evidence.previous_hash AS evidence_previous_hash,
					evidence.event_hash AS evidence_event_hash,
					evidence.occurred_at AS evidence_occurred_at
				 FROM envelope_reopen_command command
				 LEFT JOIN audit_event evidence
					ON evidence.id = command.audit_event_id
				 WHERE command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(key.actorType, key.actorId, key.idempotencyKey)
			.first<ReopenCommandRow>();
		if (row === null) return null;
		if (row.envelope_id !== key.envelopeId || row.request_hash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!validAuditEvidence(row)) return { outcome: 'integrity_error' };
		if (!(await validStoredReceipt(row))) return { outcome: 'integrity_error' };
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelope_id,
				status: 'draft',
				generation: row.expected_generation,
				fieldGeneration: row.expected_field_generation + 1,
				updatedAt: row.updated_at,
				auditEventId: row.audit_event_id
			}
		};
	}

	async #readAuditHead(envelopeId: string): Promise<ReopenAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE envelope_id = ?
				 ORDER BY sequence DESC LIMIT 1`
			)
			.bind(envelopeId)
			.first<AuditHeadRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #readLatestReadyAuditSequence(
		envelopeId: string,
		expectedGeneration: number,
		expectedCommitSha: string,
		expectedReadyAuditEventId: string
	): Promise<number | null> {
		const row: ReadyAuditAnchorRow | null = await this.#database
			.prepare(
				`SELECT ready.audit_sequence AS sequence
				 FROM envelope_ready_command ready
				 JOIN audit_event evidence
					ON evidence.envelope_id = ready.envelope_id
					AND evidence.id = ready.audit_event_id
					AND evidence.sequence = ready.audit_sequence
					AND evidence.event_type = 'envelope.ready'
				 WHERE ready.envelope_id = ?
					AND ready.expected_generation = ? AND ready.commit_sha = ?
					AND ready.audit_event_id = ?
					AND NOT EXISTS (
						SELECT 1 FROM audit_event later
						WHERE later.envelope_id = ready.envelope_id
							AND later.sequence > ready.audit_sequence
							AND later.event_type IN ('envelope.ready', 'envelope.reopened')
					)
				 LIMIT 1`
			)
			.bind(envelopeId, expectedGeneration, expectedCommitSha, expectedReadyAuditEventId)
			.first<ReadyAuditAnchorRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		return row.sequence;
	}

	async #classifyFailure(
		command: PublishReopenedEnvelopeCommand
	): Promise<PublishReopenedEnvelopeResult | null> {
		const preparation: ReopenPreparation = await this.prepareReopen(
			command,
			command.expectedGeneration,
			command.expectedFieldGeneration,
			command.expectedReadyAuditEventId
		);
		if (preparation.outcome !== 'ready') return publishFromPreparation(preparation);
		if (
			preparation.auditHead.sequence !== command.expectedAuditSequence ||
			preparation.auditHead.eventHash !== command.previousAuditHash
		) {
			return { outcome: 'audit_conflict' };
		}
		if (preparation.envelope.repositoryHead !== command.expectedCommitSha) {
			return { outcome: 'integrity_error' };
		}
		return null;
	}
}

function validAuditEvidence(row: ReopenCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'envelope.reopened' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at
	);
}

async function validStoredReceipt(row: ReopenCommandRow): Promise<boolean> {
	return validStoredReopenReceipt({
		envelopeId: row.envelope_id,
		expectedGeneration: row.expected_generation,
		expectedFieldGeneration: row.expected_field_generation,
		readyAuditEventId: row.ready_audit_event_id,
		commitSha: row.commit_sha,
		requestHash: row.request_hash,
		auditPayloadJson: row.audit_payload_json
	});
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
