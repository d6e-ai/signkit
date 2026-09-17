import postgres from 'postgres';
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
import { hashStoredAuditEvent } from '$lib/domain/audit';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class DeclinedPublicationIntegrityError extends Error {
	constructor() {
		super('Recipient declined publication integrity check failed');
		this.name = 'DeclinedPublicationIntegrityError';
	}
}

interface RecipientEnvelopeRow {
	envelopeId: string;
	recipientId: string;
	recipientRole: RecipientRole;
	recipientStatus: string;
	recipientCapabilityHash: string | null;
	recipientCapabilityExpiresAt: Date | string | null;
	recipientCapabilityRevokedAt: Date | string | null;
	routingOrder: number;
	envelopeStatus: string;
	envelopeSentCommitSha: string | null;
	envelopeRepositoryHead: string | null;
	deliveryInFlight: boolean;
	revokedRecipientIds: readonly string[];
}

interface EnvelopeLockRow {
	status: string;
	sentCommitSha: string | null;
	repositoryHead: string | null;
}

interface RecipientLockRow {
	id: string;
	envelopeId: string;
	recipientRole: RecipientRole;
	recipientStatus: string;
	recipientCapabilityHash: string | null;
	recipientCapabilityExpiresAt: Date | string | null;
	recipientCapabilityRevokedAt: Date | string | null;
	routingOrder: number;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface DeliveryLockRow {
	id: string;
	status: string;
	retryable: boolean;
}

interface DeclinedCommandRow {
	envelopeId: string;
	recipientId: string;
	recipientRole: RecipientRole;
	routingOrder: number;
	actorType: string;
	actorId: string;
	idempotencyKey: string;
	requestHash: string;
	capabilityHash: string;
	sentCommitSha: string;
	updatedAt: Date | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
	revocationEvidenceVersion: number;
	revokedRecipientIdsJson: string;
	revokedRecipientCount: number | string;
	projectionRevokedRecipientIds: readonly string[];
	projectionHasRevocableRecipient: boolean;
	projectionHasUnsafeDelivery: boolean;
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
	evidenceHashVersion: number | string | null;
}

export class PostgresRecipientDeclineStore implements RecipientDeclineStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async prepareDeclined(key: DeclineCommandKey, at: string): Promise<DeclinePreparation> {
		const row: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			this.#sql,
			key.capabilityHash
		);
		const identity: DeclinePreparation | RecipientEnvelopeRow = classifyIdentity(row, key);
		if (!isFoundRow(identity)) return identity;
		const replay: DeclinePreparation | null = await this.#resolveCommand(
			this.#sql,
			identity.recipientId,
			key
		);
		if (replay !== null) {
			if (replay.outcome !== 'replayed') return replay;
			const current: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
				this.#sql,
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
		if (identity.recipientStatus === 'declined') return { outcome: 'integrity_error' };
		if (!liveEligible(identity, key.capabilityHash, at)) return { outcome: 'not_found' };
		if (identity.deliveryInFlight) {
			return { outcome: 'delivery_in_flight' };
		}
		const auditHead: DeclineAuditHead | null = await this.#readAuditHead(
			this.#sql,
			identity.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return {
			outcome: 'ready',
			envelopeId: identity.envelopeId,
			recipientId: identity.recipientId,
			recipientRole: identity.recipientRole,
			routingOrder: identity.routingOrder,
			sentCommitSha: identity.envelopeSentCommitSha as string,
			envelopeStatus: identity.envelopeStatus as 'sent' | 'in_progress',
			revokedRecipientIds: identity.revokedRecipientIds,
			auditHead
		};
	}

	async publishDeclined(
		command: PublishRecipientDeclinedCommand
	): Promise<PublishRecipientDeclinedResult> {
		const unlocked: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			this.#sql,
			command.capabilityHash
		);
		const identity: DeclinePreparation | RecipientEnvelopeRow = classifyIdentity(unlocked, command);
		if (!isFoundRow(identity)) return publishFromPreparation(identity);
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishRecipientDeclinedResult> => {
				const envelopeRows = await transaction<EnvelopeLockRow[]>`
						SELECT status, sent_commit_sha AS "sentCommitSha", repository_head AS "repositoryHead"
						FROM envelope
						WHERE id = ${identity.envelopeId}
						FOR UPDATE`;
				if (envelopeRows.length === 0) return { outcome: 'not_found' };
				const envelope: EnvelopeLockRow = envelopeRows[0];

				const recipients = await transaction<RecipientLockRow[]>`
						SELECT id, envelope_id AS "envelopeId",
							role AS "recipientRole", status AS "recipientStatus",
							capability_hash AS "recipientCapabilityHash",
							capability_expires_at AS "recipientCapabilityExpiresAt",
							capability_revoked_at AS "recipientCapabilityRevokedAt",
							routing_order AS "routingOrder"
						FROM recipient
						WHERE envelope_id = ${identity.envelopeId}
						ORDER BY id
						FOR UPDATE`;
				const actor: RecipientLockRow | undefined = recipients.find(
					(recipient: RecipientLockRow): boolean =>
						recipient.recipientCapabilityHash === command.capabilityHash
				);
				if (actor === undefined) return { outcome: 'not_found' };
				if (
					actor.envelopeId !== command.expectedEnvelopeId ||
					actor.id !== command.expectedRecipientId
				) {
					return { outcome: 'context_mismatch' };
				}
				if (actor.recipientRole !== 'signer' && actor.recipientRole !== 'approver') {
					return { outcome: 'role_not_actionable' };
				}

				const lockedRow: RecipientEnvelopeRow = {
					envelopeId: actor.envelopeId,
					recipientId: actor.id,
					recipientRole: actor.recipientRole,
					recipientStatus: actor.recipientStatus,
					recipientCapabilityHash: actor.recipientCapabilityHash,
					recipientCapabilityExpiresAt: actor.recipientCapabilityExpiresAt,
					recipientCapabilityRevokedAt: actor.recipientCapabilityRevokedAt,
					routingOrder: actor.routingOrder,
					envelopeStatus: envelope.status,
					envelopeSentCommitSha: envelope.sentCommitSha,
					envelopeRepositoryHead: envelope.repositoryHead,
					deliveryInFlight: false,
					revokedRecipientIds: []
				};
				const raced: DeclinePreparation | null = await this.#resolveCommand(
					transaction,
					actor.id,
					command
				);
				if (raced !== null) {
					if (raced.outcome === 'replayed' && !terminalReplay(lockedRow, command.capabilityHash)) {
						return { outcome: 'integrity_error' };
					}
					return publishFromPreparation(raced);
				}
				if (lockedRow.recipientStatus === 'declined') return { outcome: 'integrity_error' };
				if (!liveEligible(lockedRow, command.capabilityHash, command.updatedAt)) {
					return { outcome: 'not_found' };
				}
				if (
					lockedRow.recipientRole !== command.recipientRole ||
					lockedRow.routingOrder !== command.routingOrder
				) {
					return { outcome: 'integrity_error' };
				}
				const revokedRecipientIds: readonly string[] = recipients
					.filter(
						(recipient: RecipientLockRow): boolean =>
							recipient.id !== actor.id &&
							recipient.recipientStatus !== 'completed' &&
							recipient.recipientCapabilityHash !== null &&
							recipient.recipientCapabilityRevokedAt === null
					)
					.map((recipient: RecipientLockRow): string => recipient.id);
				if (!sameStringArray(revokedRecipientIds, command.revokedRecipientIds)) {
					return { outcome: 'integrity_error' };
				}

				const deliveries = await transaction<DeliveryLockRow[]>`
						SELECT id, status, retryable
						FROM delivery_outbox
						WHERE envelope_id = ${actor.envelopeId}
						ORDER BY id
						FOR UPDATE`;
				if (
					deliveries.some((delivery: DeliveryLockRow): boolean => delivery.status === 'processing')
				) {
					return { outcome: 'delivery_in_flight' };
				}

				const auditHead: DeclineAuditHead | null = await this.#readAuditHead(
					transaction,
					actor.envelopeId
				);
				if (auditHead === null) return { outcome: 'integrity_error' };
				if (
					auditHead.sequence !== command.expectedAuditSequence ||
					auditHead.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'audit_conflict' };
				}

				const declinedRows = await transaction<{ id: string }[]>`
						UPDATE recipient
						SET status = 'declined', capability_revoked_at = ${command.updatedAt},
							updated_at = ${command.updatedAt}
						WHERE envelope_id = ${actor.envelopeId}
							AND id = ${actor.id} AND status IN ('pending', 'viewed')
							AND role IN ('signer', 'approver') AND role = ${command.recipientRole}
							AND routing_order = ${command.routingOrder}
							AND capability_hash = ${command.capabilityHash} AND capability_revoked_at IS NULL
							AND capability_expires_at IS NOT NULL
							AND capability_expires_at > ${command.updatedAt}::timestamptz
						RETURNING id`;
				if (declinedRows.length !== 1) throw new DeclinedPublicationIntegrityError();

				const expectedCleanupIds: readonly string[] = deliveries
					.filter(
						(delivery: DeliveryLockRow): boolean =>
							delivery.status === 'blocked' ||
							delivery.status === 'pending' ||
							(delivery.status === 'failed' && delivery.retryable)
					)
					.map((delivery: DeliveryLockRow): string => delivery.id);
				const cleanedRows = await transaction<{ id: string }[]>`
						UPDATE delivery_outbox
						SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
							sealed_capability = NULL, available_at = COALESCE(available_at, ${command.updatedAt}::timestamptz),
							last_error = 'envelope_terminal', updated_at = ${command.updatedAt}::timestamptz
						WHERE envelope_id = ${actor.envelopeId}
							AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable))
						RETURNING id`;
				const cleanedIds: readonly string[] = cleanedRows
					.map((row: { id: string }): string => row.id)
					.sort();
				if (!sameStringArray(cleanedIds, expectedCleanupIds)) {
					throw new DeclinedPublicationIntegrityError();
				}

				const revokedRows = await transaction<{ id: string }[]>`
						UPDATE recipient
						SET capability_revoked_at = ${command.updatedAt}, updated_at = ${command.updatedAt}
						WHERE envelope_id = ${actor.envelopeId}
							AND id <> ${actor.id} AND status <> 'completed'
							AND capability_hash IS NOT NULL AND capability_revoked_at IS NULL
						RETURNING id`;
				const revokedIds: readonly string[] = revokedRows
					.map((row: { id: string }): string => row.id)
					.sort();
				if (!sameStringArray(revokedIds, command.revokedRecipientIds)) {
					throw new DeclinedPublicationIntegrityError();
				}

				const envelopeUpdateRows = await transaction<{ id: string }[]>`
						UPDATE envelope
						SET status = 'declined', updated_at = ${command.updatedAt}
						WHERE id = ${actor.envelopeId}
							AND status IN ('sent', 'in_progress')
							AND sent_commit_sha = ${command.expectedSentCommitSha}
							AND sent_commit_sha = repository_head
						RETURNING id`;
				if (envelopeUpdateRows.length !== 1) throw new DeclinedPublicationIntegrityError();

				await transaction`INSERT INTO recipient_declined_command (
						envelope_id, recipient_id, recipient_role, routing_order,
						actor_type, actor_id, idempotency_key, request_hash, capability_hash,
						sent_commit_sha, updated_at, audit_event_id, audit_sequence,
						previous_audit_hash, audit_event_hash, audit_payload_json,
						revocation_evidence_version, revoked_recipient_ids_json, revoked_recipient_count
					) VALUES (${actor.envelopeId}, ${actor.id},
						${command.recipientRole}, ${command.routingOrder}, 'recipient', ${actor.id},
						${command.idempotencyKey}, ${command.requestFingerprint}, ${command.capabilityHash},
						${command.expectedSentCommitSha}, ${command.updatedAt}, ${command.auditEventId},
						${command.expectedAuditSequence + 1}, ${command.previousAuditHash}, ${command.auditEventHash},
						${command.auditPayloadJson}, ${command.revocationEvidenceVersion},
						${JSON.stringify(command.revokedRecipientIds)}, ${command.revokedRecipientIds.length})`;

				await transaction`INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at
					) VALUES (${command.auditEventId}, ${actor.envelopeId},
						${command.expectedAuditSequence + 1}, 'recipient.declined', 'recipient', ${actor.id},
						${command.auditPayloadJson}, ${command.previousAuditHash}, ${command.auditEventHash},
						${command.updatedAt})`;

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: PublishRecipientDeclinedResult | null =
				await this.#classifyFailure(command);
			if (classified !== null) return classified;
			if (error instanceof DeclinedPublicationIntegrityError) {
				return { outcome: 'integrity_error' };
			}
			throw error;
		}
	}

	async #readByCapabilityHash(
		sql: Sql,
		capabilityHash: string
	): Promise<RecipientEnvelopeRow | null> {
		const rows = await sql<RecipientEnvelopeRow[]>`
			SELECT
				recipient.envelope_id AS "envelopeId",
				recipient.id AS "recipientId",
				recipient.role AS "recipientRole",
				recipient.status AS "recipientStatus",
				recipient.capability_hash AS "recipientCapabilityHash",
				recipient.capability_expires_at AS "recipientCapabilityExpiresAt",
				recipient.capability_revoked_at AS "recipientCapabilityRevokedAt",
				recipient.routing_order AS "routingOrder",
				envelope.status AS "envelopeStatus",
				envelope.sent_commit_sha AS "envelopeSentCommitSha",
				envelope.repository_head AS "envelopeRepositoryHead",
				EXISTS (
					SELECT 1 FROM delivery_outbox delivery
					WHERE delivery.envelope_id = recipient.envelope_id
						AND delivery.status = 'processing'
				) AS "deliveryInFlight",
				ARRAY(
					SELECT sibling.id
					FROM recipient sibling
					WHERE sibling.envelope_id = recipient.envelope_id
						AND sibling.id <> recipient.id
						AND sibling.status <> 'completed'
						AND sibling.capability_hash IS NOT NULL
						AND sibling.capability_revoked_at IS NULL
					ORDER BY sibling.id
				) AS "revokedRecipientIds"
			FROM recipient
			INNER JOIN envelope
				ON envelope.id = recipient.envelope_id
			WHERE recipient.capability_hash = ${capabilityHash}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readAuditHead(sql: Sql, envelopeId: string): Promise<DeclineAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash" FROM audit_event
			WHERE envelope_id = ${envelopeId}
			ORDER BY sequence DESC LIMIT 1`;
		const row: AuditHeadRow | undefined = rows[0];
		if (row === undefined) return null;
		const sequence: number = Number(row.sequence);
		if (!Number.isSafeInteger(sequence) || sequence < 1 || row.eventHash.length === 0) return null;
		return { sequence, eventHash: row.eventHash };
	}

	async #resolveCommand(
		sql: Sql,
		recipientId: string,
		key: DeclineCommandKey
	): Promise<DeclinePreparation | null> {
		const exact: DeclinedCommandRow | null = await this.#readCommandRow(
			sql,
			recipientId,
			key.idempotencyKey
		);
		if (exact !== null) {
			if (
				exact.envelopeId !== key.expectedEnvelopeId ||
				exact.requestHash !== key.requestFingerprint ||
				exact.capabilityHash !== key.capabilityHash
			) {
				return { outcome: 'idempotency_conflict' };
			}
			return await this.#evidenceResult(exact);
		}
		const byRecipient: DeclinedCommandRow | null = await this.#readCommandRowByRecipient(
			sql,
			recipientId
		);
		if (byRecipient === null) return null;
		if (
			byRecipient.envelopeId !== key.expectedEnvelopeId ||
			byRecipient.capabilityHash !== key.capabilityHash
		) {
			return { outcome: 'not_found' };
		}
		return { outcome: 'not_found' };
	}

	async #readCommandRow(
		sql: Sql,
		recipientId: string,
		idempotencyKey: string
	): Promise<DeclinedCommandRow | null> {
		const rows = await sql<DeclinedCommandRow[]>`
			SELECT command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha", command.updated_at AS "updatedAt",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash", command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson",
				command.revocation_evidence_version AS "revocationEvidenceVersion",
				command.revoked_recipient_ids_json AS "revokedRecipientIdsJson",
				command.revoked_recipient_count AS "revokedRecipientCount",
				ARRAY(
					SELECT sibling.id FROM recipient sibling
					WHERE sibling.envelope_id = command.envelope_id
						AND sibling.id <> command.recipient_id
						AND sibling.status <> 'completed'
						AND sibling.capability_hash IS NOT NULL
						AND sibling.capability_revoked_at = command.updated_at
					ORDER BY sibling.id
				) AS "projectionRevokedRecipientIds",
				EXISTS (
					SELECT 1 FROM recipient sibling
					WHERE sibling.envelope_id = command.envelope_id
						AND sibling.id <> command.recipient_id
						AND sibling.status <> 'completed'
						AND sibling.capability_hash IS NOT NULL
						AND sibling.capability_revoked_at IS NULL
				) AS "projectionHasRevocableRecipient",
				EXISTS (
					SELECT 1 FROM delivery_outbox delivery
					WHERE delivery.envelope_id = command.envelope_id
						AND (delivery.status IN ('blocked', 'pending', 'processing')
							OR delivery.retryable OR delivery.sealed_capability IS NOT NULL)
				) AS "projectionHasUnsafeDelivery",
				evidence.id AS "evidenceEventId",
				evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt",
				evidence.hash_version AS "evidenceHashVersion"
			FROM recipient_declined_command command
			LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			WHERE command.actor_type = 'recipient'
				AND command.actor_id = ${recipientId} AND command.idempotency_key = ${idempotencyKey}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readCommandRowByRecipient(
		sql: Sql,
		recipientId: string
	): Promise<DeclinedCommandRow | null> {
		const rows = await sql<DeclinedCommandRow[]>`
			SELECT command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha", command.updated_at AS "updatedAt",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash", command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson",
				command.revocation_evidence_version AS "revocationEvidenceVersion",
				command.revoked_recipient_ids_json AS "revokedRecipientIdsJson",
				command.revoked_recipient_count AS "revokedRecipientCount",
				ARRAY(
					SELECT sibling.id FROM recipient sibling
					WHERE sibling.envelope_id = command.envelope_id
						AND sibling.id <> command.recipient_id
						AND sibling.status <> 'completed'
						AND sibling.capability_hash IS NOT NULL
						AND sibling.capability_revoked_at = command.updated_at
					ORDER BY sibling.id
				) AS "projectionRevokedRecipientIds",
				EXISTS (
					SELECT 1 FROM recipient sibling
					WHERE sibling.envelope_id = command.envelope_id
						AND sibling.id <> command.recipient_id
						AND sibling.status <> 'completed'
						AND sibling.capability_hash IS NOT NULL
						AND sibling.capability_revoked_at IS NULL
				) AS "projectionHasRevocableRecipient",
				EXISTS (
					SELECT 1 FROM delivery_outbox delivery
					WHERE delivery.envelope_id = command.envelope_id
						AND (delivery.status IN ('blocked', 'pending', 'processing')
							OR delivery.retryable OR delivery.sealed_capability IS NOT NULL)
				) AS "projectionHasUnsafeDelivery",
				evidence.id AS "evidenceEventId",
				evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt",
				evidence.hash_version AS "evidenceHashVersion"
			FROM recipient_declined_command command
			LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			WHERE command.recipient_id = ${recipientId}
			LIMIT 1`;
		return rows[0] ?? null;
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
	if (row.envelopeId !== key.expectedEnvelopeId || row.recipientId !== key.expectedRecipientId) {
		return { outcome: 'context_mismatch' };
	}
	if (row.recipientRole !== 'signer' && row.recipientRole !== 'approver') {
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
		(row.recipientStatus === 'pending' || row.recipientStatus === 'viewed') &&
		(row.recipientRole === 'signer' || row.recipientRole === 'approver') &&
		row.recipientCapabilityHash === capabilityHash &&
		row.recipientCapabilityRevokedAt === null &&
		row.recipientCapabilityExpiresAt !== null &&
		new Date(row.recipientCapabilityExpiresAt).getTime() > new Date(at).getTime() &&
		(row.envelopeStatus === 'sent' || row.envelopeStatus === 'in_progress') &&
		row.envelopeSentCommitSha !== null &&
		row.envelopeSentCommitSha === row.envelopeRepositoryHead
	);
}

function terminalReplay(row: RecipientEnvelopeRow, capabilityHash: string): boolean {
	return (
		row.recipientStatus === 'declined' &&
		row.envelopeStatus === 'declined' &&
		row.recipientCapabilityHash === capabilityHash &&
		row.recipientCapabilityRevokedAt !== null
	);
}

function validAuditEvidence(row: DeclinedCommandRow): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'recipient.declined' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt)
	);
}

async function validStoredReceipt(row: DeclinedCommandRow): Promise<boolean> {
	const requestHash: string = await sha256(
		JSON.stringify({
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			capabilityHash: row.capabilityHash
		})
	);
	const declinedAt: string = isoTimestamp(row.updatedAt);
	const baseAuditPayload = {
		recipientId: row.recipientId,
		role: row.recipientRole,
		routingOrder: row.routingOrder,
		sentCommitSha: row.sentCommitSha,
		declinedAt
	};
	const revokedRecipientIds: readonly string[] | null = parseRevokedRecipientIds(row);
	if (revokedRecipientIds === null) return false;
	const auditPayloadValue =
		row.revocationEvidenceVersion === 1
			? baseAuditPayload
			: {
					...baseAuditPayload,
					revokedCapabilities: {
						reason: 'envelope_declined',
						recipientIds: revokedRecipientIds
					}
				};
	const auditPayload: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: Number(row.auditSequence),
			eventType: 'recipient.declined',
			actorType: row.actorType,
			actorId: row.recipientId,
			occurredAt: declinedAt,
			payload: auditPayloadValue,
			previousHash: row.previousAuditHash
		},
		{ envelopeId: row.envelopeId }
	);
	return (
		requestHash === row.requestHash &&
		auditPayload === row.auditPayloadJson &&
		auditEventHash === row.auditEventHash
	);
}

function parseRevokedRecipientIds(row: DeclinedCommandRow): readonly string[] | null {
	if (row.revocationEvidenceVersion === 1) {
		return row.revokedRecipientIdsJson === '[]' && Number(row.revokedRecipientCount) === 0
			? []
			: null;
	}
	if (row.revocationEvidenceVersion !== 2) return null;
	try {
		const value: unknown = JSON.parse(row.revokedRecipientIdsJson);
		if (
			!Array.isArray(value) ||
			!value.every((id: unknown): id is string => typeof id === 'string')
		) {
			return null;
		}
		const ids: string[] = [...value];
		if (ids.length !== Number(row.revokedRecipientCount)) return null;
		const sorted: string[] = [...ids].sort();
		return sameStringArray(ids, sorted) && new Set(ids).size === ids.length ? ids : null;
	} catch {
		return null;
	}
}

function validTerminalProjection(row: DeclinedCommandRow): boolean {
	if (row.revocationEvidenceVersion === 1) return true;
	const expected: readonly string[] | null = parseRevokedRecipientIds(row);
	return (
		expected !== null &&
		sameStringArray(expected, row.projectionRevokedRecipientIds) &&
		!row.projectionHasRevocableRecipient &&
		!row.projectionHasUnsafeDelivery
	);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value: string, index: number): boolean => value === right[index])
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
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		recipientRole: row.recipientRole,
		routingOrder: row.routingOrder,
		sentCommitSha: row.sentCommitSha,
		envelopeStatus: 'declined',
		declinedAt: isoTimestamp(row.updatedAt),
		auditEventId: row.auditEventId
	};
}

function publishFromPreparation(preparation: DeclinePreparation): PublishRecipientDeclinedResult {
	if (preparation.outcome === 'ready') return { outcome: 'integrity_error' };
	return preparation;
}

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sameTimestamp(left: Date | string | null, right: Date | string): boolean {
	return left !== null && isoTimestamp(left) === isoTimestamp(right);
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
