import type { RecipientRole } from '$lib/domain/envelope';
import type {
	DeclineAuditHead,
	DeclineCommandKey,
	DeclinePreparation,
	PublishRecipientDeclinedCommand,
	PublishRecipientDeclinedResult,
	PublishedRecipientDeclined,
	RecipientDeclineStore
} from '$lib/ports/recipient-decline-store';

interface RecipientEnvelopeRow {
	organization_id: string;
	envelope_id: string;
	recipient_id: string;
	recipient_role: RecipientRole;
	recipient_status: string;
	recipient_capability_hash: string | null;
	recipient_capability_expires_at: string | null;
	recipient_capability_revoked_at: string | null;
	routing_order: number;
	envelope_status: string;
	envelope_sent_commit_sha: string | null;
	envelope_repository_head: string | null;
	delivery_in_flight: number;
	revoked_recipient_ids_json: string;
}

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

interface DeclinedCommandRow {
	organization_id: string;
	envelope_id: string;
	recipient_id: string;
	recipient_role: RecipientRole;
	routing_order: number;
	actor_type: string;
	actor_id: string;
	idempotency_key: string;
	request_hash: string;
	capability_hash: string;
	sent_commit_sha: string;
	updated_at: string;
	audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
	revocation_evidence_version: number;
	revoked_recipient_ids_json: string;
	revoked_recipient_count: number;
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
}

const DECLINED_COMMAND_COLUMNS: string = `command.organization_id, command.envelope_id, command.recipient_id,
	command.recipient_role, command.routing_order, command.actor_type, command.actor_id,
	command.idempotency_key, command.request_hash, command.capability_hash, command.sent_commit_sha,
	command.updated_at, command.audit_event_id, command.audit_sequence, command.previous_audit_hash,
	command.audit_event_hash, command.audit_payload_json, command.revocation_evidence_version,
	command.revoked_recipient_ids_json, command.revoked_recipient_count,
	(SELECT json_group_array(id) FROM (
		SELECT sibling.id FROM recipient sibling
		WHERE sibling.organization_id = command.organization_id
			AND sibling.envelope_id = command.envelope_id AND sibling.id <> command.recipient_id
			AND sibling.status <> 'completed'
			AND sibling.capability_hash IS NOT NULL
			AND sibling.capability_revoked_at = command.updated_at
		ORDER BY sibling.id
	)) AS projection_revoked_recipient_ids_json,
	EXISTS (
		SELECT 1 FROM recipient sibling
		WHERE sibling.organization_id = command.organization_id
			AND sibling.envelope_id = command.envelope_id AND sibling.id <> command.recipient_id
			AND sibling.status <> 'completed' AND sibling.capability_hash IS NOT NULL
			AND sibling.capability_revoked_at IS NULL
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
	evidence.occurred_at AS evidence_occurred_at`;

export class D1RecipientDeclineStore implements RecipientDeclineStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async prepareDeclined(key: DeclineCommandKey, at: string): Promise<DeclinePreparation> {
		const row: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(key.capabilityHash);
		const identity: DeclinePreparation | RecipientEnvelopeRow = classifyIdentity(row, key);
		if (!isFoundRow(identity)) return identity;
		const replay: DeclinePreparation | null = await this.#resolveCommand(
			identity.organization_id,
			identity.recipient_id,
			key
		);
		if (replay !== null) {
			if (replay.outcome !== 'replayed') return replay;
			const current: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
				key.capabilityHash
			);
			const currentIdentity: DeclinePreparation | RecipientEnvelopeRow = classifyIdentity(
				current,
				key
			);
			if (!isFoundRow(currentIdentity)) return { outcome: 'integrity_error' };
			if (!terminalReplay(currentIdentity, key.capabilityHash)) {
				return { outcome: 'integrity_error' };
			}
			return replay;
		}
		if (identity.recipient_status === 'declined') return { outcome: 'integrity_error' };
		if (!liveEligible(identity, key.capabilityHash, at)) return { outcome: 'not_found' };
		if (identity.delivery_in_flight === 1) {
			return { outcome: 'delivery_in_flight' };
		}
		const revokedRecipientIds: readonly string[] | null = parseStringArray(
			identity.revoked_recipient_ids_json
		);
		if (revokedRecipientIds === null) return { outcome: 'integrity_error' };
		const auditHead: DeclineAuditHead | null = await this.#readAuditHead(
			identity.organization_id,
			identity.envelope_id
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return {
			outcome: 'ready',
			organizationId: identity.organization_id,
			envelopeId: identity.envelope_id,
			recipientId: identity.recipient_id,
			recipientRole: identity.recipient_role,
			routingOrder: identity.routing_order,
			sentCommitSha: identity.envelope_sent_commit_sha as string,
			envelopeStatus: identity.envelope_status as 'sent' | 'in_progress',
			revokedRecipientIds,
			auditHead
		};
	}

	async publishDeclined(
		command: PublishRecipientDeclinedCommand
	): Promise<PublishRecipientDeclinedResult> {
		const row: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			command.capabilityHash
		);
		const identity: DeclinePreparation | RecipientEnvelopeRow = classifyIdentity(row, command);
		if (!isFoundRow(identity)) return publishFromPreparation(identity);
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO recipient_declined_command (
					organization_id, envelope_id, recipient_id, recipient_role, routing_order,
					actor_type, actor_id, idempotency_key, request_hash, capability_hash,
					sent_commit_sha, updated_at, audit_event_id, audit_sequence,
					previous_audit_hash, audit_event_hash, audit_payload_json
					, revocation_evidence_version, revoked_recipient_ids_json, revoked_recipient_count
				) VALUES (?, ?, ?, ?, ?, 'recipient', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				identity.organization_id,
				identity.envelope_id,
				identity.recipient_id,
				command.recipientRole,
				command.routingOrder,
				identity.recipient_id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.capabilityHash,
				command.expectedSentCommitSha,
				command.updatedAt,
				command.auditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventHash,
				command.auditPayloadJson,
				command.revocationEvidenceVersion,
				JSON.stringify(command.revokedRecipientIds),
				command.revokedRecipientIds.length
			);

		try {
			await this.#database.batch([statement]);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			// Re-read durable state instead of parsing provider error text. If a processing
			// lease disappears between the trigger rollback and this read, classification
			// intentionally remains unavailable so the caller can safely retry.
			const classified: PublishRecipientDeclinedResult | null =
				await this.#classifyFailure(command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async #readByCapabilityHash(capabilityHash: string): Promise<RecipientEnvelopeRow | null> {
		return await this.#database
			.prepare(
				`SELECT recipient.organization_id AS organization_id,
					recipient.envelope_id AS envelope_id,
					recipient.id AS recipient_id,
					recipient.role AS recipient_role,
					recipient.status AS recipient_status,
					recipient.capability_hash AS recipient_capability_hash,
					recipient.capability_expires_at AS recipient_capability_expires_at,
					recipient.capability_revoked_at AS recipient_capability_revoked_at,
					recipient.routing_order AS routing_order,
					envelope.status AS envelope_status,
					envelope.sent_commit_sha AS envelope_sent_commit_sha,
					envelope.repository_head AS envelope_repository_head,
					EXISTS (
						SELECT 1 FROM delivery_outbox delivery
						WHERE delivery.organization_id = recipient.organization_id
							AND delivery.envelope_id = recipient.envelope_id
							AND delivery.status = 'processing'
					) AS delivery_in_flight,
					(
						SELECT json_group_array(id)
						FROM (
							SELECT sibling.id
							FROM recipient sibling
							WHERE sibling.organization_id = recipient.organization_id
								AND sibling.envelope_id = recipient.envelope_id
								AND sibling.id <> recipient.id
								AND sibling.status <> 'completed'
								AND sibling.capability_hash IS NOT NULL
								AND sibling.capability_revoked_at IS NULL
							ORDER BY sibling.id
						)
					) AS revoked_recipient_ids_json
				 FROM recipient
				 INNER JOIN envelope
					ON envelope.organization_id = recipient.organization_id
					AND envelope.id = recipient.envelope_id
				 WHERE recipient.capability_hash = ?
				 LIMIT 1`
			)
			.bind(capabilityHash)
			.first<RecipientEnvelopeRow>();
	}

	async #readAuditHead(
		organizationId: string,
		envelopeId: string
	): Promise<DeclineAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ? ORDER BY sequence DESC LIMIT 1`
			)
			.bind(organizationId, envelopeId)
			.first<AuditHeadRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #resolveCommand(
		organizationId: string,
		recipientId: string,
		key: DeclineCommandKey
	): Promise<DeclinePreparation | null> {
		const exact: DeclinedCommandRow | null = await this.#readCommandRow(
			organizationId,
			recipientId,
			key.idempotencyKey
		);
		if (exact !== null) {
			if (
				exact.envelope_id !== key.expectedEnvelopeId ||
				exact.request_hash !== key.requestFingerprint ||
				exact.capability_hash !== key.capabilityHash
			) {
				return { outcome: 'idempotency_conflict' };
			}
			return await this.#evidenceResult(exact);
		}
		const byRecipient: DeclinedCommandRow | null = await this.#readCommandRowByRecipient(
			organizationId,
			recipientId
		);
		if (byRecipient === null) return null;
		if (
			byRecipient.envelope_id !== key.expectedEnvelopeId ||
			byRecipient.capability_hash !== key.capabilityHash
		) {
			return { outcome: 'not_found' };
		}
		return { outcome: 'not_found' };
	}

	async #readCommandRow(
		organizationId: string,
		recipientId: string,
		idempotencyKey: string
	): Promise<DeclinedCommandRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${DECLINED_COMMAND_COLUMNS}
				 FROM recipient_declined_command command
				 LEFT JOIN audit_event evidence
					ON evidence.organization_id = command.organization_id
					AND evidence.id = command.audit_event_id
				 WHERE command.organization_id = ? AND command.actor_type = 'recipient'
					AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(organizationId, recipientId, idempotencyKey)
			.first<DeclinedCommandRow>();
	}

	async #readCommandRowByRecipient(
		organizationId: string,
		recipientId: string
	): Promise<DeclinedCommandRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${DECLINED_COMMAND_COLUMNS}
				 FROM recipient_declined_command command
				 LEFT JOIN audit_event evidence
					ON evidence.organization_id = command.organization_id
					AND evidence.id = command.audit_event_id
				 WHERE command.organization_id = ? AND command.recipient_id = ?
				 LIMIT 1`
			)
			.bind(organizationId, recipientId)
			.first<DeclinedCommandRow>();
	}

	async #evidenceResult(row: DeclinedCommandRow): Promise<DeclinePreparation> {
		if (
			!validAuditEvidence(row) ||
			!(await validStoredReceipt(row)) ||
			!validTerminalProjection(row)
		) {
			return { outcome: 'integrity_error' };
		}
		return { outcome: 'replayed', result: resultFromRow(row) };
	}

	async #classifyFailure(
		command: PublishRecipientDeclinedCommand
	): Promise<PublishRecipientDeclinedResult | null> {
		const preparation: DeclinePreparation = await this.prepareDeclined(command, command.updatedAt);
		if (preparation.outcome !== 'ready') return publishFromPreparation(preparation);
		if (
			preparation.auditHead.sequence !== command.expectedAuditSequence ||
			preparation.auditHead.eventHash !== command.previousAuditHash
		) {
			return { outcome: 'audit_conflict' };
		}
		if (preparation.sentCommitSha !== command.expectedSentCommitSha) {
			return { outcome: 'integrity_error' };
		}
		if (!sameStringArray(preparation.revokedRecipientIds, command.revokedRecipientIds)) {
			return { outcome: 'integrity_error' };
		}
		return null;
	}
}

function classifyIdentity(
	row: RecipientEnvelopeRow | null,
	key: DeclineCommandKey
): DeclinePreparation | RecipientEnvelopeRow {
	if (row === null) return { outcome: 'not_found' };
	if (row.envelope_id !== key.expectedEnvelopeId || row.recipient_id !== key.expectedRecipientId) {
		return { outcome: 'context_mismatch' };
	}
	if (row.recipient_role !== 'signer' && row.recipient_role !== 'approver') {
		return { outcome: 'role_not_actionable' };
	}
	return row;
}

function isFoundRow(
	value: DeclinePreparation | RecipientEnvelopeRow
): value is RecipientEnvelopeRow {
	return !('outcome' in value);
}

function liveEligible(row: RecipientEnvelopeRow, capabilityHash: string, at: string): boolean {
	return (
		(row.recipient_status === 'pending' || row.recipient_status === 'viewed') &&
		(row.recipient_role === 'signer' || row.recipient_role === 'approver') &&
		row.recipient_capability_hash === capabilityHash &&
		row.recipient_capability_revoked_at === null &&
		row.recipient_capability_expires_at !== null &&
		new Date(row.recipient_capability_expires_at).getTime() > new Date(at).getTime() &&
		(row.envelope_status === 'sent' || row.envelope_status === 'in_progress') &&
		row.envelope_sent_commit_sha !== null &&
		row.envelope_sent_commit_sha === row.envelope_repository_head
	);
}

function terminalReplay(row: RecipientEnvelopeRow, capabilityHash: string): boolean {
	return (
		row.recipient_status === 'declined' &&
		row.envelope_status === 'declined' &&
		row.recipient_capability_hash === capabilityHash &&
		row.recipient_capability_revoked_at !== null
	);
}

function validAuditEvidence(row: DeclinedCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_organization_id === row.organization_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'recipient.declined' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at
	);
}

async function validStoredReceipt(row: DeclinedCommandRow): Promise<boolean> {
	const requestHash: string = await sha256(
		JSON.stringify({
			envelopeId: row.envelope_id,
			recipientId: row.recipient_id,
			capabilityHash: row.capability_hash
		})
	);
	const baseAuditPayload = {
		recipientId: row.recipient_id,
		role: row.recipient_role,
		routingOrder: row.routing_order,
		sentCommitSha: row.sent_commit_sha,
		declinedAt: row.updated_at
	};
	const revokedRecipientIds: readonly string[] | null = parseRevokedRecipientIds(row);
	if (revokedRecipientIds === null) return false;
	const auditPayloadValue =
		row.revocation_evidence_version === 1
			? baseAuditPayload
			: {
					...baseAuditPayload,
					revokedCapabilities: {
						reason: 'envelope_declined',
						recipientIds: revokedRecipientIds
					}
				};
	const auditPayload: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await sha256(
		JSON.stringify({
			actorId: row.recipient_id,
			envelopeId: row.envelope_id,
			eventType: 'recipient.declined',
			occurredAt: row.updated_at,
			organizationId: row.organization_id,
			payload: auditPayloadValue,
			previousHash: row.previous_audit_hash
		})
	);
	return (
		requestHash === row.request_hash &&
		auditPayload === row.audit_payload_json &&
		auditEventHash === row.audit_event_hash
	);
}

function parseRevokedRecipientIds(row: DeclinedCommandRow): readonly string[] | null {
	if (row.revocation_evidence_version === 1) {
		return row.revoked_recipient_ids_json === '[]' && row.revoked_recipient_count === 0 ? [] : null;
	}
	if (row.revocation_evidence_version !== 2) return null;
	try {
		const ids: readonly string[] | null = parseStringArray(row.revoked_recipient_ids_json);
		if (ids === null) return null;
		if (ids.length !== row.revoked_recipient_count) return null;
		const sorted: string[] = [...ids].sort();
		return sameStringArray(ids, sorted) && new Set(ids).size === ids.length ? ids : null;
	} catch {
		return null;
	}
}

function validTerminalProjection(row: DeclinedCommandRow): boolean {
	if (row.revocation_evidence_version === 1) return true;
	const expected: readonly string[] | null = parseRevokedRecipientIds(row);
	const projected: readonly string[] | null = parseStringArray(
		row.projection_revoked_recipient_ids_json
	);
	return (
		expected !== null &&
		projected !== null &&
		sameStringArray(expected, projected) &&
		row.projection_has_revocable_recipient === 0 &&
		row.projection_has_unsafe_delivery === 0
	);
}

function parseStringArray(valueJson: string): readonly string[] | null {
	try {
		const value: unknown = JSON.parse(valueJson);
		if (
			!Array.isArray(value) ||
			!value.every((id: unknown): id is string => typeof id === 'string')
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value: string, index: number) => value === right[index])
	);
}

function resultFromCommand(command: PublishRecipientDeclinedCommand): PublishedRecipientDeclined {
	return {
		envelopeId: command.expectedEnvelopeId,
		recipientId: command.expectedRecipientId,
		recipientRole: command.recipientRole,
		routingOrder: command.routingOrder,
		sentCommitSha: command.expectedSentCommitSha,
		envelopeStatus: 'declined',
		declinedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}

function resultFromRow(row: DeclinedCommandRow): PublishedRecipientDeclined {
	return {
		envelopeId: row.envelope_id,
		recipientId: row.recipient_id,
		recipientRole: row.recipient_role,
		routingOrder: row.routing_order,
		sentCommitSha: row.sent_commit_sha,
		envelopeStatus: 'declined',
		declinedAt: row.updated_at,
		auditEventId: row.audit_event_id
	};
}

function publishFromPreparation(preparation: DeclinePreparation): PublishRecipientDeclinedResult {
	if (preparation.outcome === 'ready') return { outcome: 'integrity_error' };
	return preparation;
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
