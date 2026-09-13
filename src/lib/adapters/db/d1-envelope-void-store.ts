import type {
	EnvelopeVoidStore,
	PublishVoidedEnvelopeCommand,
	PublishVoidedEnvelopeResult,
	PublishedVoidedEnvelope,
	VoidAuditHead,
	VoidCommandKey,
	VoidPreparation,
	VoidableEnvelopeStatus
} from '$lib/ports/envelope-void-store';
import { hashStoredAuditEvent } from '$lib/domain/audit';

interface EnvelopeProjectionRow {
	status: string;
	repository_generation: number;
	repository_head: string | null;
	sent_commit_sha: string | null;
	delivery_in_flight: number;
	revoked_recipient_ids_json: string;
}

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

interface VoidCommandRow {
	organization_id: string;
	envelope_id: string;
	actor_type: string;
	actor_id: string;
	idempotency_key: string;
	request_hash: string;
	previous_status: VoidableEnvelopeStatus;
	expected_generation: number;
	repository_head: string | null;
	sent_commit_sha: string | null;
	updated_at: string;
	audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
	revocation_evidence_version: number;
	revoked_recipient_ids_json: string;
	revoked_recipient_count: number;
	projection_envelope_status: string | null;
	projection_generation: number | null;
	projection_repository_head: string | null;
	projection_sent_commit_sha: string | null;
	projection_revoked_recipient_ids_json: string;
	projection_has_revocable_recipient: number;
	projection_has_unsafe_delivery: number;
	evidence_event_id: string | null;
	evidence_organization_id: string | null;
	evidence_envelope_id: string | null;
	evidence_sequence: number | null;
	evidence_event_type: string | null;
	evidence_actor_type: string | null;
	evidence_actor_id: string | null;
	evidence_payload_json: string | null;
	evidence_previous_hash: string | null;
	evidence_event_hash: string | null;
	evidence_occurred_at: string | null;
	evidence_hash_version: number | string | null;
}

const VOID_COMMAND_COLUMNS: string = `command.organization_id, command.envelope_id,
	command.actor_type, command.actor_id, command.idempotency_key, command.request_hash,
	command.previous_status, command.expected_generation, command.repository_head,
	command.sent_commit_sha, command.updated_at, command.audit_event_id, command.audit_sequence,
	command.previous_audit_hash, command.audit_event_hash, command.audit_payload_json,
	command.revocation_evidence_version, command.revoked_recipient_ids_json,
	command.revoked_recipient_count, envelope.status AS projection_envelope_status,
	envelope.repository_generation AS projection_generation,
	envelope.repository_head AS projection_repository_head,
	envelope.sent_commit_sha AS projection_sent_commit_sha,
	(SELECT json_group_array(id) FROM (
		SELECT recipient.id FROM recipient
		WHERE recipient.organization_id = command.organization_id
			AND recipient.envelope_id = command.envelope_id
			AND recipient.status <> 'completed'
			AND recipient.capability_hash IS NOT NULL
			AND recipient.capability_revoked_at = command.updated_at
		ORDER BY recipient.id
	)) AS projection_revoked_recipient_ids_json,
	EXISTS (
		SELECT 1 FROM recipient
		WHERE recipient.organization_id = command.organization_id
			AND recipient.envelope_id = command.envelope_id
			AND recipient.status <> 'completed'
			AND recipient.capability_hash IS NOT NULL
			AND recipient.capability_revoked_at IS NULL
	) AS projection_has_revocable_recipient,
	EXISTS (
		SELECT 1 FROM delivery_outbox delivery
		WHERE delivery.organization_id = command.organization_id
			AND delivery.envelope_id = command.envelope_id
			AND (delivery.status IN ('blocked', 'pending', 'processing')
				OR delivery.retryable = 1 OR delivery.sealed_capability IS NOT NULL)
	) AS projection_has_unsafe_delivery,
	evidence.id AS evidence_event_id, evidence.organization_id AS evidence_organization_id,
	evidence.envelope_id AS evidence_envelope_id, evidence.sequence AS evidence_sequence,
	evidence.event_type AS evidence_event_type, evidence.actor_type AS evidence_actor_type,
	evidence.actor_id AS evidence_actor_id, evidence.payload_json AS evidence_payload_json,
	evidence.previous_hash AS evidence_previous_hash, evidence.event_hash AS evidence_event_hash,
	evidence.occurred_at AS evidence_occurred_at, evidence.hash_version AS evidence_hash_version`;

export class D1EnvelopeVoidStore implements EnvelopeVoidStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async prepareVoid(key: VoidCommandKey): Promise<VoidPreparation> {
		const replay: VoidPreparation | null = await this.#resolveCommand(key);
		if (replay !== null) return replay;
		const row: EnvelopeProjectionRow | null = await this.#readEnvelope(key);
		if (row === null) return { outcome: 'not_found' };
		if (!isVoidableStatus(row.status)) return { outcome: 'not_voidable' };
		if (row.status !== key.expectedStatus) return { outcome: 'status_conflict' };
		if (row.repository_generation !== key.expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		if (row.delivery_in_flight === 1) return { outcome: 'delivery_in_flight' };
		const revokedRecipientIds: readonly string[] | null = parseStringArray(
			row.revoked_recipient_ids_json
		);
		if (revokedRecipientIds === null) return { outcome: 'integrity_error' };
		const auditHead: VoidAuditHead | null = await this.#readAuditHead(
			key.organizationId,
			key.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return {
			outcome: 'ready',
			previousStatus: row.status,
			generation: row.repository_generation,
			repositoryHead: row.repository_head,
			sentCommitSha: row.sent_commit_sha,
			auditHead,
			revokedRecipientIds
		};
	}

	async publishVoid(command: PublishVoidedEnvelopeCommand): Promise<PublishVoidedEnvelopeResult> {
		const replay: VoidPreparation | null = await this.#resolveCommand(command);
		if (replay !== null) return publishFromPreparation(replay);
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO envelope_void_command (
					organization_id, envelope_id, actor_type, actor_id, idempotency_key, request_hash,
					previous_status, expected_generation, repository_head, sent_commit_sha,
					updated_at, audit_event_id, audit_sequence, previous_audit_hash,
					audit_event_hash, audit_payload_json, revocation_evidence_version,
					revoked_recipient_ids_json, revoked_recipient_count
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
			)
			.bind(
				command.organizationId,
				command.envelopeId,
				command.actorType,
				command.actorId,
				command.idempotencyKey,
				command.requestFingerprint,
				command.expectedStatus,
				command.expectedGeneration,
				command.repositoryHead,
				command.sentCommitSha,
				command.updatedAt,
				command.auditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventHash,
				command.auditPayloadJson,
				JSON.stringify(command.revokedRecipientIds),
				command.revokedRecipientIds.length
			);
		try {
			await this.#database.batch([statement]);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			const classified: VoidPreparation = await this.prepareVoid(command);
			if (classified.outcome !== 'ready') return publishFromPreparation(classified);
			if (
				classified.auditHead.sequence !== command.expectedAuditSequence ||
				classified.auditHead.eventHash !== command.previousAuditHash
			) {
				return { outcome: 'audit_conflict' };
			}
			if (
				classified.repositoryHead !== command.repositoryHead ||
				classified.sentCommitSha !== command.sentCommitSha ||
				!sameStringArray(classified.revokedRecipientIds, command.revokedRecipientIds)
			) {
				return { outcome: 'integrity_error' };
			}
			throw error;
		}
	}

	async #readEnvelope(key: VoidCommandKey): Promise<EnvelopeProjectionRow | null> {
		return await this.#database
			.prepare(
				`SELECT envelope.status, envelope.repository_generation, envelope.repository_head,
					envelope.sent_commit_sha,
					EXISTS (
						SELECT 1 FROM delivery_outbox delivery
						WHERE delivery.organization_id = envelope.organization_id
							AND delivery.envelope_id = envelope.id AND delivery.status = 'processing'
					) AS delivery_in_flight,
					(SELECT json_group_array(id) FROM (
						SELECT recipient.id FROM recipient
						WHERE recipient.organization_id = envelope.organization_id
							AND recipient.envelope_id = envelope.id
							AND recipient.status <> 'completed'
							AND recipient.capability_hash IS NOT NULL
							AND recipient.capability_revoked_at IS NULL
						ORDER BY recipient.id
					)) AS revoked_recipient_ids_json
				 FROM envelope WHERE organization_id = ? AND id = ? LIMIT 1`
			)
			.bind(key.organizationId, key.envelopeId)
			.first<EnvelopeProjectionRow>();
	}

	async #readAuditHead(organizationId: string, envelopeId: string): Promise<VoidAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ? ORDER BY sequence DESC LIMIT 1`
			)
			.bind(organizationId, envelopeId)
			.first<AuditHeadRow>();
		return row === null ? null : { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #resolveCommand(key: VoidCommandKey): Promise<VoidPreparation | null> {
		const row: VoidCommandRow | null = await this.#database
			.prepare(
				`SELECT ${VOID_COMMAND_COLUMNS}
				 FROM envelope_void_command command
				 LEFT JOIN envelope ON envelope.organization_id = command.organization_id
					AND envelope.id = command.envelope_id
				 LEFT JOIN audit_event evidence ON evidence.organization_id = command.organization_id
					AND evidence.id = command.audit_event_id
				 WHERE command.organization_id = ? AND command.actor_type = ?
					AND command.actor_id = ? AND command.idempotency_key = ? LIMIT 1`
			)
			.bind(key.organizationId, key.actorType, key.actorId, key.idempotencyKey)
			.first<VoidCommandRow>();
		if (row === null) return null;
		if (
			row.envelope_id !== key.envelopeId ||
			row.request_hash !== key.requestFingerprint ||
			row.previous_status !== key.expectedStatus ||
			row.expected_generation !== key.expectedGeneration
		) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!(await validReplay(row))) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}
}

async function validReplay(row: VoidCommandRow): Promise<boolean> {
	const revokedRecipientIds: readonly string[] | null = parseRevokedRecipientIds(row);
	if (revokedRecipientIds === null) return false;
	const payloadValue = {
		previousStatus: row.previous_status,
		generation: row.expected_generation,
		repositoryHead: row.repository_head,
		sentCommitSha: row.sent_commit_sha,
		voidedAt: row.updated_at,
		revokedCapabilities: { reason: 'envelope_voided', recipientIds: revokedRecipientIds }
	};
	const auditPayloadJson: string = JSON.stringify(payloadValue);
	const requestHash: string = await sha256(
		JSON.stringify({
			expectedStatus: row.previous_status,
			expectedGeneration: row.expected_generation
		})
	);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidence_hash_version,
			sequence: row.audit_sequence,
			eventType: 'envelope.voided',
			actorType: row.actor_type,
			actorId: row.actor_id,
			occurredAt: row.updated_at,
			payload: payloadValue,
			previousHash: row.previous_audit_hash
		},
		{ organizationId: row.organization_id, envelopeId: row.envelope_id }
	);
	const projectedIds: readonly string[] | null = parseStringArray(
		row.projection_revoked_recipient_ids_json
	);
	return (
		requestHash === row.request_hash &&
		auditPayloadJson === row.audit_payload_json &&
		auditEventHash === row.audit_event_hash &&
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_organization_id === row.organization_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'envelope.voided' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at &&
		row.projection_envelope_status === 'voided' &&
		row.projection_generation === row.expected_generation &&
		row.projection_repository_head === row.repository_head &&
		row.projection_sent_commit_sha === row.sent_commit_sha &&
		projectedIds !== null &&
		sameStringArray(projectedIds, revokedRecipientIds) &&
		row.projection_has_revocable_recipient === 0 &&
		row.projection_has_unsafe_delivery === 0
	);
}

function parseRevokedRecipientIds(row: VoidCommandRow): readonly string[] | null {
	if (row.revocation_evidence_version !== 1) return null;
	const ids: readonly string[] | null = parseStringArray(row.revoked_recipient_ids_json);
	if (ids === null || ids.length !== row.revoked_recipient_count) return null;
	const sorted: string[] = [...ids].sort();
	return sameStringArray(ids, sorted) && new Set(ids).size === ids.length ? ids : null;
}

function parseStringArray(valueJson: string): readonly string[] | null {
	try {
		const value: unknown = JSON.parse(valueJson);
		return Array.isArray(value) &&
			value.every((item: unknown): item is string => typeof item === 'string')
			? value
			: null;
	} catch {
		return null;
	}
}

function isVoidableStatus(value: string): value is VoidableEnvelopeStatus {
	return value === 'draft' || value === 'ready' || value === 'sent' || value === 'in_progress';
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value: string, index: number) => value === right[index])
	);
}

function resultFromCommand(command: PublishVoidedEnvelopeCommand): PublishedVoidedEnvelope {
	return {
		envelopeId: command.envelopeId,
		status: 'voided',
		previousStatus: command.expectedStatus,
		generation: command.expectedGeneration,
		voidedAt: command.updatedAt,
		revokedCapabilityCount: command.revokedRecipientIds.length,
		auditEventId: command.auditEventId
	};
}

function resultFromRow(row: VoidCommandRow): PublishedVoidedEnvelope {
	return {
		envelopeId: row.envelope_id,
		status: 'voided',
		previousStatus: row.previous_status,
		generation: row.expected_generation,
		voidedAt: row.updated_at,
		revokedCapabilityCount: Number(row.revoked_recipient_count),
		auditEventId: row.audit_event_id
	};
}

function publishFromPreparation(preparation: VoidPreparation): PublishVoidedEnvelopeResult {
	return preparation.outcome === 'ready' ? { outcome: 'integrity_error' } : preparation;
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
