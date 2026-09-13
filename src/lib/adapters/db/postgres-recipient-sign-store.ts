import postgres from 'postgres';
import type { FieldType, RecipientRole } from '$lib/domain/envelope';
import { hashStoredAuditEvent } from '$lib/domain/audit';
import {
	canonicalRecipientSignFingerprint,
	fingerprintValuesFromStored,
	type SignAuditHead,
	type SignLookupKey,
	type SignPreparation,
	type SignRoutingSnapshot,
	type SignableFieldDeclaration,
	type SignedFieldValue,
	type StoredSignValue,
	type PublishRecipientSignedCommand,
	type PublishRecipientSignedResult,
	type PublishedRecipientSigned,
	type RecipientSignStore
} from '$lib/ports/recipient-sign-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

const MAX_RELEASE_TTL_MS: number = 15 * 24 * 60 * 60 * 1000;

class SignedPublicationIntegrityError extends Error {
	constructor() {
		super('Recipient signed publication integrity check failed');
		this.name = 'SignedPublicationIntegrityError';
	}
}

interface RecipientEnvelopeRow {
	organizationId: string;
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
	envelopeFieldGeneration: number;
}

interface EnvelopeLockRow {
	status: string;
	sentCommitSha: string | null;
	repositoryHead: string | null;
	fieldGeneration: number;
}

interface RecipientLockRow {
	id: string;
	organizationId: string;
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

interface FieldDeclarationRow {
	id: string;
	fieldType: FieldType;
	required: boolean;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface TerminalProjectionRow {
	hasRevocableRecipient: boolean;
	hasUnsafeDelivery: boolean;
}

interface EvidenceField {
	id: string;
	fieldType: FieldType;
	valueSha256: string;
}

interface SignedCommandRow {
	organizationId: string;
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
	expectedFieldGeneration: number;
	fieldValuesJson: string;
	fieldCount: number;
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
	evidenceOrganizationId: string | null;
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
	completedEvidenceOrganizationId: string | null;
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

export class PostgresRecipientSignStore implements RecipientSignStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async prepareSign(key: SignLookupKey, at: string): Promise<SignPreparation> {
		const row: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			this.#sql,
			key.capabilityHash
		);
		const identity: SignPreparation | RecipientEnvelopeRow = classifyIdentity(row, key);
		if (!isFoundRow(identity)) return identity;
		const replay: SignPreparation | null = await this.#resolveCommand(
			this.#sql,
			identity.organizationId,
			identity.recipientId,
			key
		);
		if (replay !== null) {
			if (replay.outcome !== 'existing') return replay;
			const current: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
				this.#sql,
				key.capabilityHash
			);
			const currentIdentity: SignPreparation | RecipientEnvelopeRow = classifyIdentity(
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
		const routing: SignRoutingSnapshot | null = await this.#readRouting(
			this.#sql,
			identity.organizationId,
			identity.envelopeId,
			identity.recipientId,
			identity.routingOrder
		);
		if (routing === null) return { outcome: 'integrity_error' };
		const auditHead: SignAuditHead | null = await this.#readAuditHead(
			this.#sql,
			identity.organizationId,
			identity.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const fields: readonly SignableFieldDeclaration[] = await this.#readFieldDeclarations(
			this.#sql,
			identity.organizationId,
			identity.envelopeId,
			identity.recipientId
		);
		return {
			outcome: 'ready',
			organizationId: identity.organizationId,
			envelopeId: identity.envelopeId,
			recipientId: identity.recipientId,
			recipientRole: 'signer',
			routingOrder: identity.routingOrder,
			sentCommitSha: identity.envelopeSentCommitSha as string,
			fieldGeneration: identity.envelopeFieldGeneration,
			envelopeStatus: identity.envelopeStatus as 'sent' | 'in_progress',
			auditHead,
			routing,
			fields
		};
	}

	async publishSign(command: PublishRecipientSignedCommand): Promise<PublishRecipientSignedResult> {
		const unlocked: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			this.#sql,
			command.capabilityHash
		);
		const identity: SignPreparation | RecipientEnvelopeRow = classifyIdentity(unlocked, command);
		if (!isFoundRow(identity)) return publishFromPreparation(identity);
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishRecipientSignedResult> => {
				const envelopeRows = await transaction<EnvelopeLockRow[]>`
						SELECT status, sent_commit_sha AS "sentCommitSha", repository_head AS "repositoryHead",
							field_generation AS "fieldGeneration"
						FROM envelope
						WHERE organization_id = ${identity.organizationId} AND id = ${identity.envelopeId}
						FOR UPDATE`;
				if (envelopeRows.length === 0) return { outcome: 'not_found' };
				const envelope: EnvelopeLockRow = envelopeRows[0];

				const recipients = await transaction<RecipientLockRow[]>`
						SELECT id, organization_id AS "organizationId", envelope_id AS "envelopeId",
							role AS "recipientRole", status AS "recipientStatus",
							capability_hash AS "recipientCapabilityHash",
							capability_expires_at AS "recipientCapabilityExpiresAt",
							capability_revoked_at AS "recipientCapabilityRevokedAt",
							routing_order AS "routingOrder"
						FROM recipient
						WHERE organization_id = ${identity.organizationId} AND envelope_id = ${identity.envelopeId}
						ORDER BY id
						FOR UPDATE`;

				const deliveries = await transaction<DeliveryLockRow[]>`
						SELECT id, status, retryable, sealed_capability AS "sealedCapability"
						FROM delivery_outbox
						WHERE organization_id = ${identity.organizationId} AND envelope_id = ${identity.envelopeId}
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
				if (actor.recipientRole !== 'signer') return { outcome: 'role_not_actionable' };

				const fields = await transaction<FieldDeclarationRow[]>`
						SELECT id, field_type AS "fieldType", required
						FROM envelope_field
						WHERE organization_id = ${identity.organizationId}
							AND envelope_id = ${identity.envelopeId}
							AND recipient_id = ${actor.id}
						ORDER BY id
						FOR UPDATE`;

				await transaction`
						SELECT field_id FROM field_value
						WHERE organization_id = ${identity.organizationId}
							AND envelope_id = ${identity.envelopeId}
							AND recipient_id = ${actor.id}
						ORDER BY field_id
						FOR UPDATE`;

				const lockedRow: RecipientEnvelopeRow = {
					organizationId: actor.organizationId,
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
					envelopeFieldGeneration: envelope.fieldGeneration
				};
				const raced: SignPreparation | null = await this.#resolveCommand(
					transaction,
					actor.organizationId,
					actor.id,
					command
				);
				if (raced !== null) {
					if (raced.outcome === 'existing') {
						if (raced.reconstructedFingerprint !== command.requestFingerprint) {
							return { outcome: 'idempotency_conflict' };
						}
						if (!terminalReplay(lockedRow, command.capabilityHash, raced.result.envelopeStatus)) {
							return { outcome: 'integrity_error' };
						}
						return { outcome: 'replayed', result: raced.result };
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
				if (lockedRow.envelopeFieldGeneration !== command.expectedFieldGeneration) {
					return { outcome: 'field_generation_conflict' };
				}
				if (fields.length !== command.fieldValues.length) {
					return { outcome: 'integrity_error' };
				}
				const declaredById: Map<string, FieldDeclarationRow> = new Map(
					fields.map((field: FieldDeclarationRow): [string, FieldDeclarationRow] => [
						field.id,
						field
					])
				);
				for (const value of command.fieldValues) {
					const declared: FieldDeclarationRow | undefined = declaredById.get(value.fieldId);
					if (declared === undefined || declared.fieldType !== value.fieldType) {
						return { outcome: 'integrity_error' };
					}
				}

				const routing: SignRoutingSnapshot = routingAfterActor(
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

				const auditHead: SignAuditHead | null = await this.#readAuditHead(
					transaction,
					actor.organizationId,
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
						WHERE organization_id = ${actor.organizationId} AND envelope_id = ${actor.envelopeId}
							AND id = ${actor.id} AND status = 'viewed'
							AND role = 'signer' AND role = ${command.recipientRole}
							AND routing_order = ${command.routingOrder}
							AND capability_hash = ${command.capabilityHash} AND capability_revoked_at IS NULL
							AND capability_expires_at IS NOT NULL
							AND capability_expires_at > ${command.updatedAt}::timestamptz
						RETURNING id`;
				if (completedRows.length !== 1) throw new SignedPublicationIntegrityError();

				if (command.nextRoutingOrder !== null) {
					const releasedRecipients = await transaction<{ id: string }[]>`
							UPDATE recipient
							SET capability_expires_at = ${command.nextCapabilityExpiresAt},
								updated_at = ${command.updatedAt}
							WHERE organization_id = ${actor.organizationId} AND envelope_id = ${actor.envelopeId}
								AND routing_order = ${command.nextRoutingOrder}
								AND role IN ('signer', 'approver', 'viewer') AND status <> 'completed'
								AND capability_hash IS NOT NULL AND capability_revoked_at IS NULL
								AND capability_expires_at IS NULL
							RETURNING id`;
					if (releasedRecipients.length !== command.releasedDeliveryCount) {
						throw new SignedPublicationIntegrityError();
					}
					const releasedOutbox = await transaction<{ id: string }[]>`
							UPDATE delivery_outbox AS delivery
							SET status = 'pending',
								reserved_capability_expires_at = ${command.nextCapabilityExpiresAt},
								available_at = ${command.updatedAt},
								updated_at = ${command.updatedAt}
							WHERE delivery.organization_id = ${actor.organizationId}
								AND delivery.envelope_id = ${actor.envelopeId}
								AND delivery.status = 'blocked'
								AND delivery.available_at IS NULL
								AND delivery.sealed_capability IS NOT NULL
								AND EXISTS (
									SELECT 1 FROM recipient AS target
									WHERE target.organization_id = delivery.organization_id
										AND target.id = delivery.recipient_id
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
						throw new SignedPublicationIntegrityError();
					}
				}

				if (command.completedAuditEventId !== null) {
					await transaction`
							UPDATE recipient
							SET capability_revoked_at = ${command.updatedAt}, updated_at = ${command.updatedAt}
							WHERE organization_id = ${actor.organizationId} AND envelope_id = ${actor.envelopeId}
								AND status <> 'completed' AND capability_hash IS NOT NULL
								AND capability_revoked_at IS NULL`;

					await transaction`
							UPDATE delivery_outbox
							SET status = 'failed', claim_token = NULL, locked_at = NULL,
								retryable = false, sealed_capability = NULL,
								available_at = COALESCE(available_at, ${command.updatedAt}),
								last_error = 'envelope_terminal', updated_at = ${command.updatedAt}
							WHERE organization_id = ${actor.organizationId} AND envelope_id = ${actor.envelopeId}
								AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable))`;

					const outstandingCapabilities = await transaction<{ id: string }[]>`
							SELECT id FROM recipient
							WHERE organization_id = ${actor.organizationId} AND envelope_id = ${actor.envelopeId}
								AND status <> 'completed' AND capability_hash IS NOT NULL
								AND capability_revoked_at IS NULL`;
					const unsafeDeliveries = await transaction<{ id: string }[]>`
							SELECT id FROM delivery_outbox
							WHERE organization_id = ${actor.organizationId} AND envelope_id = ${actor.envelopeId}
								AND (status IN ('blocked', 'pending', 'processing')
									OR retryable OR sealed_capability IS NOT NULL)`;
					if (outstandingCapabilities.length !== 0 || unsafeDeliveries.length !== 0) {
						throw new SignedPublicationIntegrityError();
					}
				}

				const nextEnvelopeStatus: 'completed' | null =
					command.completedAuditEventId === null ? null : 'completed';
				const envelopeUpdateRows =
					nextEnvelopeStatus === 'completed'
						? await transaction<{ id: string }[]>`
								UPDATE envelope
								SET status = 'completed', updated_at = ${command.updatedAt}
								WHERE organization_id = ${actor.organizationId} AND id = ${actor.envelopeId}
									AND status IN ('sent', 'in_progress')
									AND sent_commit_sha = ${command.expectedSentCommitSha}
									AND sent_commit_sha = repository_head
									AND field_generation = ${command.expectedFieldGeneration}
								RETURNING id`
						: await transaction<{ id: string }[]>`
								UPDATE envelope
								SET status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END,
									updated_at = ${command.updatedAt}
								WHERE organization_id = ${actor.organizationId} AND id = ${actor.envelopeId}
									AND status IN ('sent', 'in_progress')
									AND sent_commit_sha = ${command.expectedSentCommitSha}
									AND sent_commit_sha = repository_head
									AND field_generation = ${command.expectedFieldGeneration}
								RETURNING id`;
				if (envelopeUpdateRows.length !== 1) throw new SignedPublicationIntegrityError();

				const fieldValuesEvidence: readonly EvidenceField[] = command.fieldValues.map(
					(field: SignedFieldValue): EvidenceField => ({
						id: field.fieldId,
						fieldType: field.fieldType,
						valueSha256: field.valueSha256
					})
				);

				await transaction`INSERT INTO recipient_signed_command (
						organization_id, envelope_id, recipient_id, recipient_role, routing_order,
						actor_type, actor_id, idempotency_key, request_hash, capability_hash,
						sent_commit_sha, expected_field_generation, field_values_json, field_count,
						updated_at, next_routing_order, next_capability_expires_at,
						released_delivery_count, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json, completed_audit_event_id,
						completed_audit_event_hash, completed_audit_payload_json
					) VALUES (${actor.organizationId}, ${actor.envelopeId}, ${actor.id},
						${command.recipientRole}, ${command.routingOrder}, 'recipient', ${actor.id},
						${command.idempotencyKey}, ${command.requestFingerprint}, ${command.capabilityHash},
						${command.expectedSentCommitSha}, ${command.expectedFieldGeneration},
						${JSON.stringify(fieldValuesEvidence)}, ${command.fieldValues.length},
						${command.updatedAt}, ${command.nextRoutingOrder},
						${command.nextCapabilityExpiresAt}, ${command.releasedDeliveryCount},
						${command.auditEventId}, ${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.auditPayloadJson}, ${command.completedAuditEventId},
						${command.completedAuditEventHash}, ${command.completedAuditPayloadJson})`;

				for (const field of command.fieldValues) {
					await transaction`INSERT INTO field_value (
							organization_id, field_id, envelope_id, recipient_id, field_type,
							value_json, value_sha256, created_at
						) VALUES (${actor.organizationId}, ${field.fieldId}, ${actor.envelopeId}, ${actor.id},
							${field.fieldType}, ${field.valueJson}, ${field.valueSha256}, ${command.updatedAt})`;
				}

				await transaction`INSERT INTO audit_event (
						id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at
					) VALUES (${command.auditEventId}, ${actor.organizationId}, ${actor.envelopeId},
						${command.expectedAuditSequence + 1}, 'recipient.signed', 'recipient', ${actor.id},
						${command.auditPayloadJson}, ${command.previousAuditHash}, ${command.auditEventHash},
						${command.updatedAt})`;

				if (command.completedAuditEventId !== null) {
					await transaction`INSERT INTO audit_event (
							id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
							payload_json, previous_hash, event_hash, occurred_at
						) VALUES (${command.completedAuditEventId}, ${actor.organizationId}, ${actor.envelopeId},
							${command.expectedAuditSequence + 2}, 'envelope.completed', 'recipient', ${actor.id},
							${command.completedAuditPayloadJson}, ${command.auditEventHash},
							${command.completedAuditEventHash}, ${command.updatedAt})`;
				}

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: PublishRecipientSignedResult | null = await this.#classifyFailure(command);
			if (classified !== null) return classified;
			if (error instanceof SignedPublicationIntegrityError) {
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
			SELECT recipient.organization_id AS "organizationId",
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
				envelope.field_generation AS "envelopeFieldGeneration"
			FROM recipient
			INNER JOIN envelope
				ON envelope.organization_id = recipient.organization_id
				AND envelope.id = recipient.envelope_id
			WHERE recipient.capability_hash = ${capabilityHash}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readRouting(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		actorId: string,
		actorRoutingOrder: number
	): Promise<SignRoutingSnapshot | null> {
		const rows = await sql<RoutingRecipientRow[]>`
			SELECT id, role, routing_order AS "routingOrder", status
			FROM recipient
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}`;
		if (rows.length < 1 || rows.length > 50) return null;
		return routingAfterActor(actorId, actorRoutingOrder, rows);
	}

	async #readAuditHead(
		sql: Sql,
		organizationId: string,
		envelopeId: string
	): Promise<SignAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash" FROM audit_event
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY sequence DESC LIMIT 1`;
		const row: AuditHeadRow | undefined = rows[0];
		if (row === undefined) return null;
		const sequence: number = Number(row.sequence);
		if (!Number.isSafeInteger(sequence) || sequence < 1 || row.eventHash.length === 0) return null;
		return { sequence, eventHash: row.eventHash };
	}

	async #readFieldDeclarations(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		recipientId: string
	): Promise<readonly SignableFieldDeclaration[]> {
		const rows = await sql<FieldDeclarationRow[]>`
			SELECT id, field_type AS "fieldType", required
			FROM envelope_field
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
				AND recipient_id = ${recipientId}
			ORDER BY id`;
		return rows;
	}

	async #resolveCommand(
		sql: Sql,
		organizationId: string,
		recipientId: string,
		key: SignLookupKey
	): Promise<SignPreparation | null> {
		const exact: SignedCommandRow | null = await this.#readCommandRow(
			sql,
			organizationId,
			recipientId,
			key.idempotencyKey
		);
		if (exact !== null) {
			if (
				exact.envelopeId !== key.expectedEnvelopeId ||
				exact.capabilityHash !== key.capabilityHash
			) {
				return { outcome: 'idempotency_conflict' };
			}
			return await this.#evidenceResult(sql, exact);
		}
		const byRecipient: SignedCommandRow | null = await this.#readCommandRowByRecipient(
			sql,
			organizationId,
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
		organizationId: string,
		recipientId: string,
		idempotencyKey: string
	): Promise<SignedCommandRow | null> {
		const rows = await sql<SignedCommandRow[]>`
			SELECT command.organization_id AS "organizationId", command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha",
				command.expected_field_generation AS "expectedFieldGeneration",
				command.field_values_json AS "fieldValuesJson", command.field_count AS "fieldCount",
				command.updated_at AS "updatedAt",
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
				evidence.organization_id AS "evidenceOrganizationId", evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt",
				evidence.hash_version AS "evidenceHashVersion",
				completed_evidence.id AS "completedEvidenceEventId",
				completed_evidence.organization_id AS "completedEvidenceOrganizationId",
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
			FROM recipient_signed_command command
			LEFT JOIN audit_event evidence
				ON evidence.organization_id = command.organization_id AND evidence.id = command.audit_event_id
			LEFT JOIN audit_event completed_evidence
				ON completed_evidence.organization_id = command.organization_id
				AND completed_evidence.id = command.completed_audit_event_id
			WHERE command.organization_id = ${organizationId} AND command.actor_type = 'recipient'
				AND command.actor_id = ${recipientId} AND command.idempotency_key = ${idempotencyKey}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readCommandRowByRecipient(
		sql: Sql,
		organizationId: string,
		recipientId: string
	): Promise<SignedCommandRow | null> {
		const rows = await sql<SignedCommandRow[]>`
			SELECT command.organization_id AS "organizationId", command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha",
				command.expected_field_generation AS "expectedFieldGeneration",
				command.field_values_json AS "fieldValuesJson", command.field_count AS "fieldCount",
				command.updated_at AS "updatedAt",
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
				evidence.organization_id AS "evidenceOrganizationId", evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt",
				evidence.hash_version AS "evidenceHashVersion",
				completed_evidence.id AS "completedEvidenceEventId",
				completed_evidence.organization_id AS "completedEvidenceOrganizationId",
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
			FROM recipient_signed_command command
			LEFT JOIN audit_event evidence
				ON evidence.organization_id = command.organization_id AND evidence.id = command.audit_event_id
			LEFT JOIN audit_event completed_evidence
				ON completed_evidence.organization_id = command.organization_id
				AND completed_evidence.id = command.completed_audit_event_id
			WHERE command.organization_id = ${organizationId} AND command.recipient_id = ${recipientId}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readStoredValues(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		recipientId: string
	): Promise<readonly StoredSignValue[]> {
		const rows = await sql<
			{
				fieldId: string;
				fieldType: FieldType;
				valueJson: string;
				valueSha256: string;
			}[]
		>`
			SELECT field_id AS "fieldId", field_type AS "fieldType",
				value_json AS "valueJson", value_sha256 AS "valueSha256"
			FROM field_value
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
				AND recipient_id = ${recipientId}
			ORDER BY field_id`;
		return rows;
	}

	async #evidenceResult(sql: Sql, row: SignedCommandRow): Promise<SignPreparation> {
		const stored: readonly StoredSignValue[] = await this.#readStoredValues(
			sql,
			row.organizationId,
			row.envelopeId,
			row.recipientId
		);
		const reconstructed: string | null = await reconstructedFingerprint(row, stored);
		if (
			reconstructed === null ||
			!validAuditEvidence(row) ||
			!(await validStoredReceipt(row, stored, reconstructed))
		) {
			return { outcome: 'integrity_error' };
		}
		const result: PublishedRecipientSigned = resultFromRow(row);
		if (
			result.envelopeStatus === 'completed' &&
			!(await this.#terminalProjectionIntact(sql, row.organizationId, row.envelopeId))
		) {
			return { outcome: 'integrity_error' };
		}
		return {
			outcome: 'existing',
			reconstructedFingerprint: reconstructed,
			result,
			storedFields: stored.map((value: StoredSignValue): SignableFieldDeclaration => ({
				id: value.fieldId,
				fieldType: value.fieldType,
				required: false
			}))
		};
	}

	async #terminalProjectionIntact(
		sql: Sql,
		organizationId: string,
		envelopeId: string
	): Promise<boolean> {
		const rows = await sql<TerminalProjectionRow[]>`
			SELECT EXISTS (
				SELECT 1 FROM recipient
				WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
					AND status <> 'completed' AND capability_hash IS NOT NULL
					AND capability_revoked_at IS NULL
			) AS "hasRevocableRecipient",
			EXISTS (
				SELECT 1 FROM delivery_outbox
				WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
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
		command: PublishRecipientSignedCommand
	): Promise<PublishRecipientSignedResult | null> {
		const preparation: SignPreparation = await this.prepareSign(command, command.updatedAt);
		if (preparation.outcome === 'existing') {
			if (preparation.reconstructedFingerprint !== command.requestFingerprint) {
				return { outcome: 'idempotency_conflict' };
			}
			return { outcome: 'replayed', result: preparation.result };
		}
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
		if (preparation.fieldGeneration !== command.expectedFieldGeneration) {
			return { outcome: 'field_generation_conflict' };
		}
		if (!commandMatchesRouting(command, preparation.routing)) {
			return { outcome: 'integrity_error' };
		}
		return null;
	}
}

function classifyIdentity(
	row: RecipientEnvelopeRow | null,
	key: SignLookupKey
): SignPreparation | RecipientEnvelopeRow {
	if (row === null) return { outcome: 'not_found' };
	if (row.envelopeId !== key.expectedEnvelopeId || row.recipientId !== key.expectedRecipientId) {
		return { outcome: 'context_mismatch' };
	}
	if (row.recipientRole !== 'signer') return { outcome: 'role_not_actionable' };
	return row;
}

function isFoundRow(value: SignPreparation | RecipientEnvelopeRow): value is RecipientEnvelopeRow {
	return !('outcome' in value);
}

function liveEligible(row: RecipientEnvelopeRow, capabilityHash: string, at: string): boolean {
	return (
		row.recipientStatus === 'viewed' &&
		row.recipientRole === 'signer' &&
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
): SignRoutingSnapshot {
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
	command: PublishRecipientSignedCommand,
	routing: SignRoutingSnapshot
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

function validAuditEvidence(row: SignedCommandRow): boolean {
	const signedMatches: boolean =
		row.evidenceEventId === row.auditEventId &&
		row.evidenceOrganizationId === row.organizationId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'recipient.signed' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt);
	if (!signedMatches) return false;
	if (row.completedAuditEventId === null) {
		return (
			row.completedAuditEventHash === null &&
			row.completedAuditPayloadJson === null &&
			row.completedEvidenceEventId === null
		);
	}
	return (
		row.completedEvidenceEventId === row.completedAuditEventId &&
		row.completedEvidenceOrganizationId === row.organizationId &&
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

function parseEvidenceFields(value: string): readonly EvidenceField[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const fields: EvidenceField[] = [];
	for (const candidate of parsed) {
		if (
			typeof candidate !== 'object' ||
			candidate === null ||
			typeof (candidate as Record<string, unknown>).id !== 'string' ||
			typeof (candidate as Record<string, unknown>).fieldType !== 'string' ||
			typeof (candidate as Record<string, unknown>).valueSha256 !== 'string'
		) {
			return null;
		}
		fields.push(candidate as EvidenceField);
	}
	return fields;
}

async function reconstructedFingerprint(
	row: SignedCommandRow,
	stored: readonly StoredSignValue[]
): Promise<string | null> {
	if (stored.length !== Number(row.fieldCount)) return null;
	for (const value of stored) {
		const digest: string = await sha256(value.valueJson);
		if (digest !== value.valueSha256) return null;
	}
	const values = fingerprintValuesFromStored(stored);
	if (values === null) return null;
	return sha256(
		canonicalRecipientSignFingerprint({
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			capabilityHash: row.capabilityHash,
			expectedFieldGeneration: Number(row.expectedFieldGeneration),
			values
		})
	);
}

async function validStoredReceipt(
	row: SignedCommandRow,
	stored: readonly StoredSignValue[],
	reconstructedFingerprint: string
): Promise<boolean> {
	if (reconstructedFingerprint !== row.requestHash) return false;
	const fields: readonly EvidenceField[] | null = parseEvidenceFields(row.fieldValuesJson);
	if (
		fields === null ||
		fields.length !== Number(row.fieldCount) ||
		fields.length !== stored.length
	) {
		return false;
	}
	const digestById: Map<string, string> = new Map(
		stored.map((value: StoredSignValue): [string, string] => [value.fieldId, value.valueSha256])
	);
	for (const field of fields) {
		if (digestById.get(field.id) !== field.valueSha256) return false;
	}

	const signedAt: string = isoTimestamp(row.updatedAt);
	const auditPayloadValue = {
		recipientId: row.recipientId,
		role: row.recipientRole,
		routingOrder: Number(row.routingOrder),
		sentCommitSha: row.sentCommitSha,
		fields: fields.map((field: EvidenceField) => ({
			id: field.id,
			fieldType: field.fieldType,
			valueSha256: field.valueSha256
		})),
		signedAt
	};
	const auditPayload: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: Number(row.auditSequence),
			eventType: 'recipient.signed',
			actorType: row.actorType,
			actorId: row.recipientId,
			occurredAt: signedAt,
			payload: auditPayloadValue,
			previousHash: row.previousAuditHash
		},
		{ organizationId: row.organizationId, envelopeId: row.envelopeId }
	);
	if (auditPayload !== row.auditPayloadJson || auditEventHash !== row.auditEventHash) {
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
			completedAt: signedAt
		};
		const completedPayload: string = JSON.stringify(completedPayloadValue);
		const completedEventHash: string = await hashStoredAuditEvent(
			{
				hashVersion: row.completedEvidenceHashVersion,
				sequence: Number(row.auditSequence) + 1,
				eventType: 'envelope.completed',
				actorType: row.actorType,
				actorId: row.recipientId,
				occurredAt: signedAt,
				payload: completedPayloadValue,
				previousHash: row.auditEventHash
			},
			{ organizationId: row.organizationId, envelopeId: row.envelopeId }
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

function resultFromCommand(command: PublishRecipientSignedCommand): PublishedRecipientSigned {
	return {
		envelopeId: command.expectedEnvelopeId,
		recipientId: command.expectedRecipientId,
		recipientRole: 'signer',
		routingOrder: command.routingOrder,
		sentCommitSha: command.expectedSentCommitSha,
		envelopeStatus: command.completedAuditEventId === null ? 'in_progress' : 'completed',
		signedAt: command.updatedAt,
		auditEventId: command.auditEventId,
		completedAuditEventId: command.completedAuditEventId,
		nextRoutingOrder: command.nextRoutingOrder
	};
}

function resultFromRow(row: SignedCommandRow): PublishedRecipientSigned {
	return {
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		recipientRole: 'signer',
		routingOrder: Number(row.routingOrder),
		sentCommitSha: row.sentCommitSha,
		envelopeStatus: row.completedAuditEventId === null ? 'in_progress' : 'completed',
		signedAt: isoTimestamp(row.updatedAt),
		auditEventId: row.auditEventId,
		completedAuditEventId: row.completedAuditEventId,
		nextRoutingOrder: row.nextRoutingOrder === null ? null : Number(row.nextRoutingOrder)
	};
}

function publishFromPreparation(preparation: SignPreparation): PublishRecipientSignedResult {
	if (preparation.outcome === 'ready' || preparation.outcome === 'existing') {
		return { outcome: 'integrity_error' };
	}
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
