import postgres from 'postgres';
import type {
	ProvenRecipientCompletedReceipt,
	RecipientCompletedReceiptAction,
	RecipientCompletedReceiptIdentity,
	RecipientCompletedReceiptStore
} from '$lib/ports/recipient-completed-receipt-store';
import {
	proveRecipientCompletedReceipt,
	type RecipientCompletedReceiptEvidenceRow
} from './recipient-completed-receipt-evidence';

const ACTIONS: readonly RecipientCompletedReceiptAction[] = ['signed', 'approved'];

const COMMAND_TABLE: Readonly<Record<RecipientCompletedReceiptAction, string>> = {
	signed: 'recipient_signed_command',
	approved: 'recipient_approved_command'
};

export class PostgresRecipientCompletedReceiptStore implements RecipientCompletedReceiptStore {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	/**
	 * A recipient holds exactly one action-bearing role, so at most one command
	 * table can answer. Evidence in both is a contradiction and fails closed.
	 */
	async findByCapabilityHash(
		capabilityHash: string
	): Promise<ProvenRecipientCompletedReceipt | null> {
		const found: ProvenRecipientCompletedReceipt[] = [];
		for (const action of ACTIONS) {
			const rows: RecipientCompletedReceiptEvidenceRow[] = await this.sql<
				RecipientCompletedReceiptEvidenceRow[]
			>`
				SELECT ${this.sql.unsafe(evidenceColumns(action))}
				${this.sql.unsafe(evidenceFrom(action))}
				WHERE command.capability_hash = ${capabilityHash}`;
			const receipt: ProvenRecipientCompletedReceipt | null = await proveUnique(rows, action);
			if (receipt !== null) found.push(receipt);
		}
		return found.length === 1 ? found[0] : null;
	}

	async findByIdentity(
		identity: RecipientCompletedReceiptIdentity
	): Promise<ProvenRecipientCompletedReceipt | null> {
		if (!ACTIONS.includes(identity.action)) return null;
		const rows: RecipientCompletedReceiptEvidenceRow[] = await this.sql<
			RecipientCompletedReceiptEvidenceRow[]
		>`
			SELECT ${this.sql.unsafe(evidenceColumns(identity.action))}
			${this.sql.unsafe(evidenceFrom(identity.action))}
			WHERE command.envelope_id = ${identity.envelopeId}
				AND command.recipient_id = ${identity.recipientId}
				AND command.idempotency_key = ${identity.idempotencyKey}
				AND command.capability_hash = ${identity.capabilityHash}`;
		return await proveUnique(rows, identity.action);
	}
}

/**
 * Signer commands expose the declared `{id, fieldType, valueSha256}` digests
 * alongside the same digests re-read from the immutable `field_value` rows,
 * each joined to an `envelope_field` this recipient owns in this envelope.
 * `field_value.value_json` is never selected, so submitted content cannot
 * reach a receipt.
 */
const SIGNED_FIELD_COLUMNS: string = `
	command.field_values_json AS "fieldValuesJson",
	command.field_count AS "fieldCount",
	COALESCE((
		SELECT json_agg(json_build_object(
			'id', declared.id, 'fieldType', declared."fieldType", 'valueSha256', declared."valueSha256"
		) ORDER BY declared.id)::text
		FROM (
			SELECT submitted.field_id AS id,
				submitted.field_type AS "fieldType",
				submitted.value_sha256 AS "valueSha256"
			FROM field_value submitted
			INNER JOIN envelope_field declaration
				ON declaration.id = submitted.field_id
				AND declaration.envelope_id = submitted.envelope_id
				AND declaration.recipient_id = submitted.recipient_id
				AND declaration.field_type = submitted.field_type
			WHERE submitted.envelope_id = command.envelope_id
				AND submitted.recipient_id = command.recipient_id
		) declared
	), '[]') AS "durableFieldDigestsJson"`;

const APPROVED_FIELD_COLUMNS: string = `
	NULL::text AS "fieldValuesJson",
	NULL::integer AS "fieldCount",
	NULL::text AS "durableFieldDigestsJson"`;

function evidenceColumns(action: RecipientCompletedReceiptAction): string {
	return `
	command.envelope_id AS "envelopeId",
	command.recipient_id AS "recipientId",
	command.recipient_role AS "recipientRole",
	command.routing_order AS "routingOrder",
	command.actor_type AS "actorType",
	command.actor_id AS "actorId",
	command.idempotency_key AS "idempotencyKey",
	command.request_hash AS "requestHash",
	command.capability_hash AS "capabilityHash",
	command.sent_commit_sha AS "sentCommitSha",
	command.updated_at AS "updatedAt",
	command.next_routing_order AS "nextRoutingOrder",
	command.next_capability_expires_at AS "nextCapabilityExpiresAt",
	command.released_delivery_count AS "releasedDeliveryCount",
	command.audit_event_id AS "auditEventId",
	command.audit_sequence AS "auditSequence",
	command.previous_audit_hash AS "previousAuditHash",
	command.audit_event_hash AS "auditEventHash",
	command.audit_payload_json AS "auditPayloadJson",
	command.completed_audit_event_id AS "completedAuditEventId",
	command.completed_audit_event_hash AS "completedAuditEventHash",
	command.completed_audit_payload_json AS "completedAuditPayloadJson",
	${action === 'signed' ? SIGNED_FIELD_COLUMNS : APPROVED_FIELD_COLUMNS},
	recipient.status AS "recipientStatus",
	recipient.role AS "recipientProjectedRole",
	recipient.locale AS "recipientLocale",
	recipient.capability_hash AS "recipientCapabilityHash",
	recipient.capability_revoked_at AS "recipientCapabilityRevokedAt",
	envelope.status AS "envelopeStatus",
	envelope.sent_commit_sha AS "envelopeSentCommitSha",
	envelope.repository_head AS "envelopeRepositoryHead",
	evidence.id AS "evidenceEventId",
	evidence.envelope_id AS "evidenceEnvelopeId",
	evidence.sequence AS "evidenceSequence",
	evidence.event_type AS "evidenceEventType",
	evidence.actor_type AS "evidenceActorType",
	evidence.actor_id AS "evidenceActorId",
	evidence.payload_json AS "evidencePayloadJson",
	evidence.previous_hash AS "evidencePreviousHash",
	evidence.event_hash AS "evidenceEventHash",
	evidence.occurred_at AS "evidenceOccurredAt",
	evidence.hash_version AS "evidenceHashVersion",
	previous.envelope_id AS "previousEnvelopeId",
	previous.sequence AS "previousSequence",
	previous.event_hash AS "previousEventHash",
	completion.id AS "completionEventId",
	completion.envelope_id AS "completionEnvelopeId",
	completion.sequence AS "completionSequence",
	completion.event_type AS "completionEventType",
	completion.actor_type AS "completionActorType",
	completion.actor_id AS "completionActorId",
	completion.payload_json AS "completionPayloadJson",
	completion.previous_hash AS "completionPreviousHash",
	completion.event_hash AS "completionEventHash",
	completion.occurred_at AS "completionOccurredAt",
	completion.hash_version AS "completionHashVersion"`;
}

function evidenceFrom(action: RecipientCompletedReceiptAction): string {
	return `
	FROM ${COMMAND_TABLE[action]} command
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
		AND previous.sequence = command.audit_sequence - 1
	LEFT JOIN audit_event completion
		ON completion.envelope_id = command.envelope_id
		AND completion.id = command.completed_audit_event_id`;
}

async function proveUnique(
	rows: readonly RecipientCompletedReceiptEvidenceRow[],
	action: RecipientCompletedReceiptAction
): Promise<ProvenRecipientCompletedReceipt | null> {
	if (rows.length !== 1) return null;
	return await proveRecipientCompletedReceipt(rows[0], action);
}
