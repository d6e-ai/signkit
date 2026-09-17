import type {
	ProvenRecipientDeclinedReceipt,
	RecipientDeclinedReceiptIdentity,
	RecipientDeclinedReceiptStore
} from '$lib/ports/recipient-declined-receipt-store';
import {
	proveRecipientDeclinedReceipt,
	type RecipientDeclinedReceiptEvidenceRow
} from './recipient-declined-receipt-evidence';

const EVIDENCE_COLUMNS: string = `
	command.envelope_id AS envelopeId,
	command.recipient_id AS recipientId,
	command.recipient_role AS recipientRole,
	command.routing_order AS routingOrder,
	command.actor_type AS actorType,
	command.actor_id AS actorId,
	command.idempotency_key AS idempotencyKey,
	command.request_hash AS requestHash,
	command.capability_hash AS capabilityHash,
	command.sent_commit_sha AS sentCommitSha,
	command.updated_at AS updatedAt,
	command.audit_event_id AS auditEventId,
	command.audit_sequence AS auditSequence,
	command.previous_audit_hash AS previousAuditHash,
	command.audit_event_hash AS auditEventHash,
	command.audit_payload_json AS auditPayloadJson,
	command.revocation_evidence_version AS revocationEvidenceVersion,
	command.revoked_recipient_ids_json AS revokedRecipientIdsJson,
	command.revoked_recipient_count AS revokedRecipientCount,
	(SELECT json_group_array(id) FROM (
		SELECT sibling.id FROM recipient sibling
		WHERE sibling.envelope_id = command.envelope_id
			AND sibling.id <> command.recipient_id
			AND sibling.status <> 'completed'
			AND sibling.capability_hash IS NOT NULL
			AND sibling.capability_revoked_at = command.updated_at
		ORDER BY sibling.id
	)) AS projectionRevokedRecipientIdsJson,
	EXISTS (
		SELECT 1 FROM recipient sibling
		WHERE sibling.envelope_id = command.envelope_id
			AND sibling.id <> command.recipient_id
			AND sibling.status <> 'completed'
			AND sibling.capability_hash IS NOT NULL
			AND sibling.capability_revoked_at IS NULL
	) AS projectionHasRevocableRecipient,
	EXISTS (
		SELECT 1 FROM delivery_outbox delivery
		WHERE delivery.envelope_id = command.envelope_id
			AND (delivery.status IN ('blocked', 'pending', 'processing')
				OR delivery.retryable = 1 OR delivery.sealed_capability IS NOT NULL)
	) AS projectionHasUnsafeDelivery,
	recipient.status AS recipientStatus,
	recipient.locale AS recipientLocale,
	recipient.capability_hash AS recipientCapabilityHash,
	recipient.capability_revoked_at AS recipientCapabilityRevokedAt,
	envelope.status AS envelopeStatus,
	envelope.sent_commit_sha AS envelopeSentCommitSha,
	envelope.repository_head AS envelopeRepositoryHead,
	evidence.id AS evidenceEventId,
	evidence.envelope_id AS evidenceEnvelopeId,
	evidence.sequence AS evidenceSequence,
	evidence.event_type AS evidenceEventType,
	evidence.actor_type AS evidenceActorType,
	evidence.actor_id AS evidenceActorId,
	evidence.payload_json AS evidencePayloadJson,
	evidence.previous_hash AS evidencePreviousHash,
	evidence.event_hash AS evidenceEventHash,
	evidence.occurred_at AS evidenceOccurredAt,
	evidence.hash_version AS evidenceHashVersion,
	previous.envelope_id AS previousEnvelopeId,
	previous.sequence AS previousSequence,
	previous.event_hash AS previousEventHash`;

const EVIDENCE_FROM: string = `
	FROM recipient_declined_command command
	INNER JOIN recipient
		ON recipient.envelope_id = command.envelope_id
		AND recipient.id = command.recipient_id
		AND recipient.capability_hash = command.capability_hash
	INNER JOIN envelope
		ON envelope.id = command.envelope_id
	LEFT JOIN audit_event evidence
		ON evidence.envelope_id = command.envelope_id
		AND evidence.id = command.audit_event_id
	LEFT JOIN audit_event previous
		ON previous.envelope_id = command.envelope_id
		AND previous.sequence = command.audit_sequence - 1`;

export const D1_RECIPIENT_DECLINED_RECEIPT_BY_CAPABILITY_QUERY: string = `
	SELECT ${EVIDENCE_COLUMNS}
	${EVIDENCE_FROM}
	WHERE command.capability_hash = ?`;

export const D1_RECIPIENT_DECLINED_RECEIPT_BY_IDENTITY_QUERY: string = `
	SELECT ${EVIDENCE_COLUMNS}
	${EVIDENCE_FROM}
	WHERE command.envelope_id = ?
		AND command.recipient_id = ?
		AND command.idempotency_key = ?
		AND command.capability_hash = ?`;

export class D1RecipientDeclinedReceiptStore implements RecipientDeclinedReceiptStore {
	constructor(private readonly database: D1Database) {}

	async findByCapabilityHash(
		capabilityHash: string
	): Promise<ProvenRecipientDeclinedReceipt | null> {
		return await this.#find(
			this.database.prepare(D1_RECIPIENT_DECLINED_RECEIPT_BY_CAPABILITY_QUERY).bind(capabilityHash)
		);
	}

	async findByIdentity(
		identity: RecipientDeclinedReceiptIdentity
	): Promise<ProvenRecipientDeclinedReceipt | null> {
		return await this.#find(
			this.database
				.prepare(D1_RECIPIENT_DECLINED_RECEIPT_BY_IDENTITY_QUERY)
				.bind(
					identity.envelopeId,
					identity.recipientId,
					identity.idempotencyKey,
					identity.capabilityHash
				)
		);
	}

	async #find(statement: D1PreparedStatement): Promise<ProvenRecipientDeclinedReceipt | null> {
		const result: D1Result<RecipientDeclinedReceiptEvidenceRow> =
			await statement.all<RecipientDeclinedReceiptEvidenceRow>();
		if (result.results.length !== 1) return null;
		return await proveRecipientDeclinedReceipt(result.results[0]);
	}
}
