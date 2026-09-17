import postgres from 'postgres';
import type { RecipientRole } from '$lib/domain/envelope';
import type {
	ApproveAuditHead,
	ApproveCommandKey,
	ApprovePreparation,
	ApproveRoutingSnapshot,
	PublishRecipientApprovedCommand,
	PublishRecipientApprovedResult,
	PublishedRecipientApproved,
	RecipientApproveStore
} from '$lib/ports/recipient-approve-store';
import { hashStoredAuditEvent } from '$lib/domain/audit';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

const MAX_RELEASE_TTL_MS: number = 15 * 24 * 60 * 60 * 1000;

class ApprovedPublicationIntegrityError extends Error {
	constructor() {
		super('Recipient approved publication integrity check failed');
		this.name = 'ApprovedPublicationIntegrityError';
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

interface DeliveryLockRow {
	id: string;
	status: string;
	retryable: boolean;
	sealedCapability: string | null;
}

interface RoutingRecipientRow {
	id: string;
	role: RecipientRole;
	routingOrder: number;
	status: string;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface TerminalProjectionRow {
	hasRevocableRecipient: boolean;
	hasUnsafeDelivery: boolean;
}

interface ApprovedCommandRow {
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
	nextRoutingOrder: number | string | null;
	nextCapabilityExpiresAt: Date | string | null;
	releasedDeliveryCount: number | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
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
	completedEvidenceEventId: string | null;
	completedEvidenceEnvelopeId: string | null;
	completedEvidenceSequence: number | string | null;
	completedEvidenceEventType: string | null;
	completedEvidenceActorType: string | null;
	completedEvidenceActorId: string | null;
	completedEvidencePayloadJson: string | null;
	completedEvidencePreviousHash: string | null;
	completedEvidenceEventHash: string | null;
	completedEvidenceOccurredAt: Date | string | null;
	completedEvidenceHashVersion: number | string | null;
}

export class PostgresRecipientApproveStore implements RecipientApproveStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async prepareApproved(key: ApproveCommandKey, at: string): Promise<ApprovePreparation> {
		const row: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			this.#sql,
			key.capabilityHash
		);
		const identity: ApprovePreparation | RecipientEnvelopeRow = classifyIdentity(row, key);
		if (!isFoundRow(identity)) return identity;
		const replay: ApprovePreparation | null = await this.#resolveCommand(
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
			const currentIdentity: ApprovePreparation | RecipientEnvelopeRow = classifyIdentity(
				current,
				key
			);
			if (!isFoundRow(currentIdentity)) return { outcome: 'integrity_error' };
			if (!terminalReplay(currentIdentity, key.capabilityHash, replay.result.envelopeStatus)) {
				return { outcome: 'integrity_error' };
			}
			return replay;
		}
		if (identity.recipientStatus === 'completed') return { outcome: 'integrity_error' };
		if (!liveEligible(identity, key.capabilityHash, at)) return { outcome: 'not_found' };
		const routing: ApproveRoutingSnapshot | null = await this.#readRouting(
			this.#sql,
			identity.envelopeId,
			identity.recipientId,
			identity.routingOrder
		);
		if (routing === null) return { outcome: 'integrity_error' };
		const auditHead: ApproveAuditHead | null = await this.#readAuditHead(
			this.#sql,
			identity.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return {
			outcome: 'ready',
			envelopeId: identity.envelopeId,
			recipientId: identity.recipientId,
			recipientRole: 'approver',
			routingOrder: identity.routingOrder,
			sentCommitSha: identity.envelopeSentCommitSha as string,
			envelopeStatus: identity.envelopeStatus as 'sent' | 'in_progress',
			auditHead,
			routing
		};
	}

	async publishApproved(
		command: PublishRecipientApprovedCommand
	): Promise<PublishRecipientApprovedResult> {
		const unlocked: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			this.#sql,
			command.capabilityHash
		);
		const identity: ApprovePreparation | RecipientEnvelopeRow = classifyIdentity(unlocked, command);
		if (!isFoundRow(identity)) return publishFromPreparation(identity);
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishRecipientApprovedResult> => {
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

				const deliveries = await transaction<DeliveryLockRow[]>`
						SELECT id, status, retryable, sealed_capability AS "sealedCapability"
						FROM delivery_outbox
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
				if (actor.recipientRole !== 'approver') return { outcome: 'role_not_actionable' };

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
					envelopeRepositoryHead: envelope.repositoryHead
				};
				const raced: ApprovePreparation | null = await this.#resolveCommand(
					transaction,
					actor.id,
					command
				);
				if (raced !== null) {
					if (
						raced.outcome === 'replayed' &&
						!terminalReplay(lockedRow, command.capabilityHash, raced.result.envelopeStatus)
					) {
						return { outcome: 'integrity_error' };
					}
					return publishFromPreparation(raced);
				}
				if (lockedRow.recipientStatus === 'completed') return { outcome: 'integrity_error' };
				if (!liveEligible(lockedRow, command.capabilityHash, command.updatedAt)) {
					return { outcome: 'not_found' };
				}
				if (
					lockedRow.recipientRole !== command.recipientRole ||
					lockedRow.routingOrder !== command.routingOrder
				) {
					return { outcome: 'integrity_error' };
				}

				const routing: ApproveRoutingSnapshot = routingAfterActor(
					actor.id,
					actor.routingOrder,
					recipients.map((recipient: RecipientLockRow): RoutingRecipientRow => ({
						id: recipient.id,
						role: recipient.recipientRole,
						routingOrder: recipient.routingOrder,
						status: recipient.recipientStatus
					}))
				);
				if (!commandMatchesRouting(command, routing)) {
					return { outcome: 'integrity_error' };
				}
				if (
					command.completedAuditEventId !== null &&
					deliveries.some((delivery: DeliveryLockRow): boolean => delivery.status === 'processing')
				) {
					return { outcome: 'delivery_in_flight' };
				}

				const auditHead: ApproveAuditHead | null = await this.#readAuditHead(
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

				const completedRows = await transaction<{ id: string }[]>`
						UPDATE recipient
						SET status = 'completed', capability_revoked_at = ${command.updatedAt},
							updated_at = ${command.updatedAt}
						WHERE envelope_id = ${actor.envelopeId}
							AND id = ${actor.id} AND status = 'viewed'
							AND role = 'approver' AND role = ${command.recipientRole}
							AND routing_order = ${command.routingOrder}
							AND capability_hash = ${command.capabilityHash} AND capability_revoked_at IS NULL
							AND capability_expires_at IS NOT NULL
							AND capability_expires_at > ${command.updatedAt}::timestamptz
						RETURNING id`;
				if (completedRows.length !== 1) throw new ApprovedPublicationIntegrityError();

				if (command.nextRoutingOrder !== null) {
					const releasedRecipients = await transaction<{ id: string }[]>`
							UPDATE recipient
							SET capability_expires_at = ${command.nextCapabilityExpiresAt},
								updated_at = ${command.updatedAt}
							WHERE envelope_id = ${actor.envelopeId}
								AND routing_order = ${command.nextRoutingOrder}
								AND role IN ('signer', 'approver', 'viewer') AND status <> 'completed'
								AND capability_hash IS NOT NULL AND capability_revoked_at IS NULL
								AND capability_expires_at IS NULL
							RETURNING id`;
					if (releasedRecipients.length !== command.releasedDeliveryCount) {
						throw new ApprovedPublicationIntegrityError();
					}
					const releasedOutbox = await transaction<{ id: string }[]>`
							UPDATE delivery_outbox AS delivery
							SET status = 'pending',
								reserved_capability_expires_at = ${command.nextCapabilityExpiresAt},
								available_at = ${command.updatedAt},
								updated_at = ${command.updatedAt}
							WHERE delivery.envelope_id = ${actor.envelopeId}
								AND delivery.status = 'blocked'
								AND delivery.available_at IS NULL
								AND delivery.sealed_capability IS NOT NULL
								AND EXISTS (
									SELECT 1 FROM recipient AS target
									WHERE target.id = delivery.recipient_id
										AND target.envelope_id = delivery.envelope_id
										AND target.routing_order = ${command.nextRoutingOrder}
										AND target.role IN ('signer', 'approver', 'viewer')
										AND target.status <> 'completed'
										AND target.capability_revoked_at IS NULL
										AND target.capability_expires_at = ${command.nextCapabilityExpiresAt}
										AND target.capability_hash = delivery.capability_hash
								)
							RETURNING delivery.id`;
					if (releasedOutbox.length !== command.releasedDeliveryCount) {
						throw new ApprovedPublicationIntegrityError();
					}
				}

				if (command.completedAuditEventId !== null) {
					await transaction`
							UPDATE recipient
							SET capability_revoked_at = ${command.updatedAt}, updated_at = ${command.updatedAt}
							WHERE envelope_id = ${actor.envelopeId}
								AND status <> 'completed' AND capability_hash IS NOT NULL
								AND capability_revoked_at IS NULL`;

					await transaction`
							UPDATE delivery_outbox
							SET status = 'failed', claim_token = NULL, locked_at = NULL,
								retryable = false, sealed_capability = NULL,
								available_at = COALESCE(available_at, ${command.updatedAt}),
								last_error = 'envelope_terminal', updated_at = ${command.updatedAt}
							WHERE envelope_id = ${actor.envelopeId}
								AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable))`;

					const outstandingCapabilities = await transaction<{ id: string }[]>`
							SELECT id FROM recipient
							WHERE envelope_id = ${actor.envelopeId}
								AND status <> 'completed' AND capability_hash IS NOT NULL
								AND capability_revoked_at IS NULL`;
					const unsafeDeliveries = await transaction<{ id: string }[]>`
							SELECT id FROM delivery_outbox
							WHERE envelope_id = ${actor.envelopeId}
								AND (status IN ('blocked', 'pending', 'processing')
									OR retryable OR sealed_capability IS NOT NULL)`;
					if (outstandingCapabilities.length !== 0 || unsafeDeliveries.length !== 0) {
						throw new ApprovedPublicationIntegrityError();
					}
				}

				const nextEnvelopeStatus: 'completed' | null =
					command.completedAuditEventId === null ? null : 'completed';
				const envelopeUpdateRows =
					nextEnvelopeStatus === 'completed'
						? await transaction<{ id: string }[]>`
								UPDATE envelope
								SET status = 'completed', updated_at = ${command.updatedAt}
								WHERE id = ${actor.envelopeId}
									AND status IN ('sent', 'in_progress')
									AND sent_commit_sha = ${command.expectedSentCommitSha}
									AND sent_commit_sha = repository_head
								RETURNING id`
						: await transaction<{ id: string }[]>`
								UPDATE envelope
								SET status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END,
									updated_at = ${command.updatedAt}
								WHERE id = ${actor.envelopeId}
									AND status IN ('sent', 'in_progress')
									AND sent_commit_sha = ${command.expectedSentCommitSha}
									AND sent_commit_sha = repository_head
								RETURNING id`;
				if (envelopeUpdateRows.length !== 1) throw new ApprovedPublicationIntegrityError();

				await transaction`INSERT INTO recipient_approved_command (
						envelope_id, recipient_id, recipient_role, routing_order,
						actor_type, actor_id, idempotency_key, request_hash, capability_hash,
						sent_commit_sha, updated_at, next_routing_order, next_capability_expires_at,
						released_delivery_count, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json, completed_audit_event_id,
						completed_audit_event_hash, completed_audit_payload_json
					) VALUES (${actor.envelopeId}, ${actor.id},
						${command.recipientRole}, ${command.routingOrder}, 'recipient', ${actor.id},
						${command.idempotencyKey}, ${command.requestFingerprint}, ${command.capabilityHash},
						${command.expectedSentCommitSha}, ${command.updatedAt}, ${command.nextRoutingOrder},
						${command.nextCapabilityExpiresAt}, ${command.releasedDeliveryCount},
						${command.auditEventId}, ${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.auditPayloadJson}, ${command.completedAuditEventId},
						${command.completedAuditEventHash}, ${command.completedAuditPayloadJson})`;

				await transaction`INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at
					) VALUES (${command.auditEventId}, ${actor.envelopeId},
						${command.expectedAuditSequence + 1}, 'recipient.approved', 'recipient', ${actor.id},
						${command.auditPayloadJson}, ${command.previousAuditHash}, ${command.auditEventHash},
						${command.updatedAt})`;

				if (command.completedAuditEventId !== null) {
					await transaction`INSERT INTO audit_event (
							id, envelope_id, sequence, event_type, actor_type, actor_id,
							payload_json, previous_hash, event_hash, occurred_at
						) VALUES (${command.completedAuditEventId}, ${actor.envelopeId},
							${command.expectedAuditSequence + 2}, 'envelope.completed', 'recipient', ${actor.id},
							${command.completedAuditPayloadJson}, ${command.auditEventHash},
							${command.completedAuditEventHash}, ${command.updatedAt})`;
				}

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: PublishRecipientApprovedResult | null =
				await this.#classifyFailure(command);
			if (classified !== null) return classified;
			if (error instanceof ApprovedPublicationIntegrityError) {
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
				envelope.repository_head AS "envelopeRepositoryHead"
			FROM recipient
			INNER JOIN envelope
				ON envelope.id = recipient.envelope_id
			WHERE recipient.capability_hash = ${capabilityHash}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readRouting(
		sql: Sql,
		envelopeId: string,
		actorId: string,
		actorRoutingOrder: number
	): Promise<ApproveRoutingSnapshot | null> {
		const rows = await sql<RoutingRecipientRow[]>`
			SELECT id, role, routing_order AS "routingOrder", status
			FROM recipient
			WHERE envelope_id = ${envelopeId}`;
		if (rows.length < 1 || rows.length > 50) return null;
		return routingAfterActor(actorId, actorRoutingOrder, rows);
	}

	async #readAuditHead(sql: Sql, envelopeId: string): Promise<ApproveAuditHead | null> {
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
		key: ApproveCommandKey
	): Promise<ApprovePreparation | null> {
		const exact: ApprovedCommandRow | null = await this.#readCommandRow(
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
			return await this.#evidenceResult(sql, exact);
		}
		const byRecipient: ApprovedCommandRow | null = await this.#readCommandRowByRecipient(
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
	): Promise<ApprovedCommandRow | null> {
		const rows = await sql<ApprovedCommandRow[]>`
			SELECT command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha", command.updated_at AS "updatedAt",
				command.next_routing_order AS "nextRoutingOrder",
				command.next_capability_expires_at AS "nextCapabilityExpiresAt",
				command.released_delivery_count AS "releasedDeliveryCount",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash", command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson",
				command.completed_audit_event_id AS "completedAuditEventId",
				command.completed_audit_event_hash AS "completedAuditEventHash",
				command.completed_audit_payload_json AS "completedAuditPayloadJson",
				evidence.id AS "evidenceEventId",
				evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt",
				evidence.hash_version AS "evidenceHashVersion",
				completed_evidence.id AS "completedEvidenceEventId",
				completed_evidence.envelope_id AS "completedEvidenceEnvelopeId",
				completed_evidence.sequence AS "completedEvidenceSequence",
				completed_evidence.event_type AS "completedEvidenceEventType",
				completed_evidence.actor_type AS "completedEvidenceActorType",
				completed_evidence.actor_id AS "completedEvidenceActorId",
				completed_evidence.payload_json AS "completedEvidencePayloadJson",
				completed_evidence.previous_hash AS "completedEvidencePreviousHash",
				completed_evidence.event_hash AS "completedEvidenceEventHash",
				completed_evidence.occurred_at AS "completedEvidenceOccurredAt",
				completed_evidence.hash_version AS "completedEvidenceHashVersion"
			FROM recipient_approved_command command
			LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			LEFT JOIN audit_event completed_evidence
				ON completed_evidence.id = command.completed_audit_event_id
			WHERE command.actor_type = 'recipient'
				AND command.actor_id = ${recipientId} AND command.idempotency_key = ${idempotencyKey}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readCommandRowByRecipient(
		sql: Sql,
		recipientId: string
	): Promise<ApprovedCommandRow | null> {
		const rows = await sql<ApprovedCommandRow[]>`
			SELECT command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha", command.updated_at AS "updatedAt",
				command.next_routing_order AS "nextRoutingOrder",
				command.next_capability_expires_at AS "nextCapabilityExpiresAt",
				command.released_delivery_count AS "releasedDeliveryCount",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash", command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson",
				command.completed_audit_event_id AS "completedAuditEventId",
				command.completed_audit_event_hash AS "completedAuditEventHash",
				command.completed_audit_payload_json AS "completedAuditPayloadJson",
				evidence.id AS "evidenceEventId",
				evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt",
				evidence.hash_version AS "evidenceHashVersion",
				completed_evidence.id AS "completedEvidenceEventId",
				completed_evidence.envelope_id AS "completedEvidenceEnvelopeId",
				completed_evidence.sequence AS "completedEvidenceSequence",
				completed_evidence.event_type AS "completedEvidenceEventType",
				completed_evidence.actor_type AS "completedEvidenceActorType",
				completed_evidence.actor_id AS "completedEvidenceActorId",
				completed_evidence.payload_json AS "completedEvidencePayloadJson",
				completed_evidence.previous_hash AS "completedEvidencePreviousHash",
				completed_evidence.event_hash AS "completedEvidenceEventHash",
				completed_evidence.occurred_at AS "completedEvidenceOccurredAt",
				completed_evidence.hash_version AS "completedEvidenceHashVersion"
			FROM recipient_approved_command command
			LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			LEFT JOIN audit_event completed_evidence
				ON completed_evidence.id = command.completed_audit_event_id
			WHERE command.recipient_id = ${recipientId}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #evidenceResult(sql: Sql, row: ApprovedCommandRow): Promise<ApprovePreparation> {
		if (!validAuditEvidence(row) || !(await validStoredReceipt(row))) {
			return { outcome: 'integrity_error' };
		}
		const result: PublishedRecipientApproved = resultFromRow(row);
		if (
			result.envelopeStatus === 'completed' &&
			!(await this.#terminalProjectionIntact(sql, row.envelopeId))
		) {
			return { outcome: 'integrity_error' };
		}
		return { outcome: 'replayed', result };
	}

	async #terminalProjectionIntact(sql: Sql, envelopeId: string): Promise<boolean> {
		const rows = await sql<TerminalProjectionRow[]>`
			SELECT EXISTS (
				SELECT 1 FROM recipient
				WHERE envelope_id = ${envelopeId}
					AND status <> 'completed' AND capability_hash IS NOT NULL
					AND capability_revoked_at IS NULL
			) AS "hasRevocableRecipient",
			EXISTS (
				SELECT 1 FROM delivery_outbox
				WHERE envelope_id = ${envelopeId}
					AND (status IN ('blocked', 'pending', 'processing')
						OR retryable OR sealed_capability IS NOT NULL)
			) AS "hasUnsafeDelivery"`;
		const projection: TerminalProjectionRow | undefined = rows[0];
		return (
			projection !== undefined &&
			projection.hasRevocableRecipient === false &&
			projection.hasUnsafeDelivery === false
		);
	}

	async #classifyFailure(
		command: PublishRecipientApprovedCommand
	): Promise<PublishRecipientApprovedResult | null> {
		const preparation: ApprovePreparation = await this.prepareApproved(command, command.updatedAt);
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
		if (!commandMatchesRouting(command, preparation.routing)) {
			return { outcome: 'integrity_error' };
		}
		return null;
	}
}

function classifyIdentity(
	row: RecipientEnvelopeRow | null,
	key: ApproveCommandKey
): ApprovePreparation | RecipientEnvelopeRow {
	if (row === null) return { outcome: 'not_found' };
	if (row.envelopeId !== key.expectedEnvelopeId || row.recipientId !== key.expectedRecipientId) {
		return { outcome: 'context_mismatch' };
	}
	if (row.recipientRole !== 'approver') return { outcome: 'role_not_actionable' };
	return row;
}

function isFoundRow(
	value: ApprovePreparation | RecipientEnvelopeRow
): value is RecipientEnvelopeRow {
	return !('outcome' in value);
}

function liveEligible(row: RecipientEnvelopeRow, capabilityHash: string, at: string): boolean {
	return (
		row.recipientStatus === 'viewed' &&
		row.recipientRole === 'approver' &&
		row.recipientCapabilityHash === capabilityHash &&
		row.recipientCapabilityRevokedAt === null &&
		row.recipientCapabilityExpiresAt !== null &&
		new Date(row.recipientCapabilityExpiresAt).getTime() > new Date(at).getTime() &&
		(row.envelopeStatus === 'sent' || row.envelopeStatus === 'in_progress') &&
		row.envelopeSentCommitSha !== null &&
		row.envelopeSentCommitSha === row.envelopeRepositoryHead
	);
}

function terminalReplay(
	row: RecipientEnvelopeRow,
	capabilityHash: string,
	envelopeStatus: 'in_progress' | 'completed'
): boolean {
	return (
		row.recipientStatus === 'completed' &&
		(row.envelopeStatus === envelopeStatus ||
			(envelopeStatus === 'in_progress' && row.envelopeStatus === 'completed')) &&
		row.recipientCapabilityHash === capabilityHash &&
		row.recipientCapabilityRevokedAt !== null
	);
}

function routingAfterActor(
	actorId: string,
	actorRoutingOrder: number,
	recipients: readonly RoutingRecipientRow[]
): ApproveRoutingSnapshot {
	const remainingActionable: RoutingRecipientRow[] = recipients.filter(
		(recipient: RoutingRecipientRow): boolean =>
			recipient.id !== actorId &&
			(recipient.role === 'signer' || recipient.role === 'approver') &&
			recipient.status !== 'completed'
	);
	const laterOrders: number[] = remainingActionable
		.filter((recipient: RoutingRecipientRow): boolean => recipient.routingOrder > actorRoutingOrder)
		.map((recipient: RoutingRecipientRow): number => recipient.routingOrder);
	const nextRoutingOrder: number | null =
		laterOrders.length === 0 ? null : Math.min(...laterOrders);
	return {
		currentGroupOutstanding: remainingActionable.filter(
			(recipient: RoutingRecipientRow): boolean => recipient.routingOrder === actorRoutingOrder
		).length,
		remainingActionableOutstanding: remainingActionable.length,
		nextRoutingOrder,
		nextGroupCount:
			nextRoutingOrder === null
				? 0
				: recipients.filter(
						(recipient: RoutingRecipientRow): boolean =>
							recipient.id !== actorId &&
							isDeliveryRole(recipient.role) &&
							recipient.status !== 'completed' &&
							recipient.routingOrder === nextRoutingOrder
					).length
	};
}

function isDeliveryRole(role: RecipientRole): boolean {
	return role === 'signer' || role === 'approver' || role === 'viewer';
}

function commandMatchesRouting(
	command: PublishRecipientApprovedCommand,
	routing: ApproveRoutingSnapshot
): boolean {
	const shouldComplete: boolean = routing.remainingActionableOutstanding === 0;
	const shouldRelease: boolean =
		!shouldComplete && routing.currentGroupOutstanding === 0 && routing.nextRoutingOrder !== null;
	if (shouldComplete) {
		return (
			command.completedAuditEventId !== null &&
			command.completedAuditEventHash !== null &&
			command.completedAuditPayloadJson !== null &&
			command.nextRoutingOrder === null &&
			command.nextCapabilityExpiresAt === null &&
			command.releasedDeliveryCount === 0
		);
	}
	if (shouldRelease) {
		return (
			command.completedAuditEventId === null &&
			command.completedAuditEventHash === null &&
			command.completedAuditPayloadJson === null &&
			command.nextRoutingOrder === routing.nextRoutingOrder &&
			command.nextCapabilityExpiresAt !== null &&
			new Date(command.nextCapabilityExpiresAt).getTime() > new Date(command.updatedAt).getTime() &&
			new Date(command.nextCapabilityExpiresAt).getTime() <=
				new Date(command.updatedAt).getTime() + MAX_RELEASE_TTL_MS &&
			command.releasedDeliveryCount === routing.nextGroupCount
		);
	}
	return (
		command.completedAuditEventId === null &&
		command.completedAuditEventHash === null &&
		command.completedAuditPayloadJson === null &&
		command.nextRoutingOrder === null &&
		command.nextCapabilityExpiresAt === null &&
		command.releasedDeliveryCount === 0
	);
}

function validAuditEvidence(row: ApprovedCommandRow): boolean {
	const approvedMatches: boolean =
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'recipient.approved' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt);
	if (!approvedMatches) return false;
	if (row.completedAuditEventId === null) {
		return (
			row.completedAuditEventHash === null &&
			row.completedAuditPayloadJson === null &&
			row.completedEvidenceEventId === null
		);
	}
	return (
		row.completedEvidenceEventId === row.completedAuditEventId &&
		row.completedEvidenceEnvelopeId === row.envelopeId &&
		Number(row.completedEvidenceSequence) === Number(row.auditSequence) + 1 &&
		row.completedEvidenceEventType === 'envelope.completed' &&
		row.completedEvidenceActorType === row.actorType &&
		row.completedEvidenceActorId === row.actorId &&
		row.completedEvidencePayloadJson === row.completedAuditPayloadJson &&
		row.completedEvidencePreviousHash === row.auditEventHash &&
		row.completedEvidenceEventHash === row.completedAuditEventHash &&
		sameTimestamp(row.completedEvidenceOccurredAt, row.updatedAt)
	);
}

async function validStoredReceipt(row: ApprovedCommandRow): Promise<boolean> {
	const requestHash: string = await sha256(
		JSON.stringify({
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			capabilityHash: row.capabilityHash
		})
	);
	const approvedAt: string = isoTimestamp(row.updatedAt);
	const auditPayloadValue = {
		recipientId: row.recipientId,
		role: row.recipientRole,
		routingOrder: Number(row.routingOrder),
		sentCommitSha: row.sentCommitSha,
		approvedAt
	};
	const auditPayload: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: Number(row.auditSequence),
			eventType: 'recipient.approved',
			actorType: row.actorType,
			actorId: row.recipientId,
			occurredAt: approvedAt,
			payload: auditPayloadValue,
			previousHash: row.previousAuditHash
		},
		{ envelopeId: row.envelopeId }
	);
	if (
		requestHash !== row.requestHash ||
		auditPayload !== row.auditPayloadJson ||
		auditEventHash !== row.auditEventHash
	) {
		return false;
	}
	if (row.completedAuditEventId !== null) {
		if (
			row.nextRoutingOrder !== null ||
			row.nextCapabilityExpiresAt !== null ||
			Number(row.releasedDeliveryCount) !== 0 ||
			row.completedAuditEventHash === null ||
			row.completedAuditPayloadJson === null
		) {
			return false;
		}
		const completedPayloadValue = {
			sentCommitSha: row.sentCommitSha,
			completedAt: approvedAt
		};
		const completedPayload: string = JSON.stringify(completedPayloadValue);
		const completedEventHash: string = await hashStoredAuditEvent(
			{
				hashVersion: row.completedEvidenceHashVersion,
				sequence: Number(row.auditSequence) + 1,
				eventType: 'envelope.completed',
				actorType: row.actorType,
				actorId: row.recipientId,
				occurredAt: approvedAt,
				payload: completedPayloadValue,
				previousHash: row.auditEventHash
			},
			{ envelopeId: row.envelopeId }
		);
		return (
			completedPayload === row.completedAuditPayloadJson &&
			completedEventHash === row.completedAuditEventHash
		);
	}
	if (row.nextRoutingOrder !== null) {
		return (
			row.nextCapabilityExpiresAt !== null &&
			Number(row.releasedDeliveryCount) > 0 &&
			row.completedAuditEventHash === null &&
			row.completedAuditPayloadJson === null
		);
	}
	return (
		row.nextCapabilityExpiresAt === null &&
		Number(row.releasedDeliveryCount) === 0 &&
		row.completedAuditEventHash === null &&
		row.completedAuditPayloadJson === null
	);
}

function resultFromCommand(command: PublishRecipientApprovedCommand): PublishedRecipientApproved {
	return {
		envelopeId: command.expectedEnvelopeId,
		recipientId: command.expectedRecipientId,
		recipientRole: 'approver',
		routingOrder: command.routingOrder,
		sentCommitSha: command.expectedSentCommitSha,
		envelopeStatus: command.completedAuditEventId === null ? 'in_progress' : 'completed',
		approvedAt: command.updatedAt,
		auditEventId: command.auditEventId,
		completedAuditEventId: command.completedAuditEventId,
		nextRoutingOrder: command.nextRoutingOrder
	};
}

function resultFromRow(row: ApprovedCommandRow): PublishedRecipientApproved {
	return {
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		recipientRole: 'approver',
		routingOrder: Number(row.routingOrder),
		sentCommitSha: row.sentCommitSha,
		envelopeStatus: row.completedAuditEventId === null ? 'in_progress' : 'completed',
		approvedAt: isoTimestamp(row.updatedAt),
		auditEventId: row.auditEventId,
		completedAuditEventId: row.completedAuditEventId,
		nextRoutingOrder: row.nextRoutingOrder === null ? null : Number(row.nextRoutingOrder)
	};
}

function publishFromPreparation(preparation: ApprovePreparation): PublishRecipientApprovedResult {
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
