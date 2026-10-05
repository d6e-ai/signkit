import {
	isPostSendInvitationRecipientRole,
	type FieldType,
	type RecipientRole
} from '$lib/domain/envelope';
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

const MAX_RELEASE_TTL_MS: number = 15 * 24 * 60 * 60 * 1000;

interface RecipientEnvelopeRow {
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
	envelope_field_generation: number;
}

interface RoutingRecipientRow {
	id: string;
	role: RecipientRole;
	routing_order: number;
	status: string;
}

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

interface FieldDeclarationRow {
	id: string;
	field_type: FieldType;
	required: number;
}

interface SignedCommandRow {
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
	expected_field_generation: number;
	field_values_json: string;
	field_count: number;
	updated_at: string;
	next_routing_order: number | null;
	next_capability_expires_at: string | null;
	released_delivery_count: number;
	audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
	completed_audit_event_id: string | null;
	completed_audit_event_hash: string | null;
	completed_audit_payload_json: string | null;
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
	evidence_hash_version: number | string | null;
	completed_evidence_event_id: string | null;
	completed_evidence_envelope_id: string | null;
	completed_evidence_sequence: number | null;
	completed_evidence_event_type: string | null;
	completed_evidence_actor_type: string | null;
	completed_evidence_actor_id: string | null;
	completed_evidence_payload_json: string | null;
	completed_evidence_previous_hash: string | null;
	completed_evidence_event_hash: string | null;
	completed_evidence_occurred_at: string | null;
	completed_evidence_hash_version: number | string | null;
}

interface EvidenceField {
	id: string;
	fieldType: FieldType;
	valueSha256: string;
}

const SIGNED_COMMAND_COLUMNS: string = `command.envelope_id, command.recipient_id,
	command.recipient_role, command.routing_order, command.actor_type, command.actor_id,
	command.idempotency_key, command.request_hash, command.capability_hash, command.sent_commit_sha,
	command.expected_field_generation, command.field_values_json, command.field_count,
	command.updated_at, command.next_routing_order, command.next_capability_expires_at,
	command.released_delivery_count, command.audit_event_id, command.audit_sequence,
	command.previous_audit_hash, command.audit_event_hash, command.audit_payload_json,
	command.completed_audit_event_id, command.completed_audit_event_hash, command.completed_audit_payload_json,
	evidence.id AS evidence_event_id, evidence.envelope_id AS evidence_envelope_id, evidence.sequence AS evidence_sequence,
	evidence.event_type AS evidence_event_type, evidence.actor_type AS evidence_actor_type,
	evidence.actor_id AS evidence_actor_id, evidence.payload_json AS evidence_payload_json,
	evidence.previous_hash AS evidence_previous_hash, evidence.event_hash AS evidence_event_hash,
	evidence.occurred_at AS evidence_occurred_at, evidence.hash_version AS evidence_hash_version,
	completed_evidence.id AS completed_evidence_event_id,
	completed_evidence.envelope_id AS completed_evidence_envelope_id,
	completed_evidence.sequence AS completed_evidence_sequence,
	completed_evidence.event_type AS completed_evidence_event_type,
	completed_evidence.actor_type AS completed_evidence_actor_type,
	completed_evidence.actor_id AS completed_evidence_actor_id,
	completed_evidence.payload_json AS completed_evidence_payload_json,
	completed_evidence.previous_hash AS completed_evidence_previous_hash,
	completed_evidence.event_hash AS completed_evidence_event_hash,
	completed_evidence.occurred_at AS completed_evidence_occurred_at,
	completed_evidence.hash_version AS completed_evidence_hash_version`;

export class D1RecipientSignStore implements RecipientSignStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async prepareSign(key: SignLookupKey, at: string): Promise<SignPreparation> {
		const row: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(key.capabilityHash);
		const identity: SignPreparation | RecipientEnvelopeRow = classifyIdentity(row, key);
		if (!isFoundRow(identity)) return identity;
		const replay: SignPreparation | null = await this.#resolveCommand(identity.recipient_id, key);
		if (replay !== null) {
			if (replay.outcome !== 'existing') return replay;
			const current: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
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
			if (
				replay.result.envelopeStatus === 'completed' &&
				!(await this.#validCompletedProjection(currentIdentity.envelope_id))
			) {
				return { outcome: 'integrity_error' };
			}
			return replay;
		}
		if (identity.recipient_status === 'completed') return { outcome: 'integrity_error' };
		if (!liveEligible(identity, key.capabilityHash, at)) return { outcome: 'not_found' };
		const routing: SignRoutingSnapshot | null = await this.#readRouting(
			identity.envelope_id,
			identity.recipient_id,
			identity.routing_order
		);
		if (routing === null) return { outcome: 'integrity_error' };
		const auditHead: SignAuditHead | null = await this.#readAuditHead(identity.envelope_id);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const fields: readonly SignableFieldDeclaration[] = await this.#readFieldDeclarations(
			identity.envelope_id,
			identity.recipient_id
		);
		return {
			outcome: 'ready',
			envelopeId: identity.envelope_id,
			recipientId: identity.recipient_id,
			recipientRole: 'signer',
			routingOrder: identity.routing_order,
			sentCommitSha: identity.envelope_sent_commit_sha as string,
			fieldGeneration: identity.envelope_field_generation,
			envelopeStatus: identity.envelope_status as 'sent' | 'in_progress',
			auditHead,
			routing,
			fields
		};
	}

	async publishSign(command: PublishRecipientSignedCommand): Promise<PublishRecipientSignedResult> {
		const row: RecipientEnvelopeRow | null = await this.#readByCapabilityHash(
			command.capabilityHash
		);
		const identity: SignPreparation | RecipientEnvelopeRow = classifyIdentity(row, command);
		if (!isFoundRow(identity)) return publishFromPreparation(identity);

		const fieldValuesEvidence: readonly EvidenceField[] = command.fieldValues.map(
			(field: SignedFieldValue): EvidenceField => ({
				id: field.fieldId,
				fieldType: field.fieldType,
				valueSha256: field.valueSha256
			})
		);
		const statements: D1PreparedStatement[] = [
			this.#database
				.prepare(
					`INSERT INTO recipient_signed_command (
						envelope_id, recipient_id, recipient_role, routing_order,
						actor_type, actor_id, idempotency_key, request_hash, capability_hash,
						sent_commit_sha, expected_field_generation, field_values_json, field_count,
						updated_at, next_routing_order, next_capability_expires_at,
						released_delivery_count, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json, completed_audit_event_id,
						completed_audit_event_hash, completed_audit_payload_json
					) VALUES (?, ?, ?, ?, 'recipient', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					identity.envelope_id,
					identity.recipient_id,
					command.recipientRole,
					command.routingOrder,
					identity.recipient_id,
					command.idempotencyKey,
					command.requestFingerprint,
					command.capabilityHash,
					command.expectedSentCommitSha,
					command.expectedFieldGeneration,
					JSON.stringify(fieldValuesEvidence),
					command.fieldValues.length,
					command.updatedAt,
					command.nextRoutingOrder,
					command.nextCapabilityExpiresAt,
					command.releasedDeliveryCount,
					command.auditEventId,
					command.expectedAuditSequence + 1,
					command.previousAuditHash,
					command.auditEventHash,
					command.auditPayloadJson,
					command.completedAuditEventId,
					command.completedAuditEventHash,
					command.completedAuditPayloadJson
				),
			...command.fieldValues.map((field: SignedFieldValue): D1PreparedStatement =>
				this.#database
					.prepare(
						`INSERT INTO field_value (
							field_id, envelope_id, recipient_id, field_type,
							value_json, value_sha256, created_at
						) VALUES (?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						field.fieldId,
						identity.envelope_id,
						identity.recipient_id,
						field.fieldType,
						field.valueJson,
						field.valueSha256,
						command.updatedAt
					)
			)
		];

		try {
			await this.#database.batch(statements);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			const classified: PublishRecipientSignedResult | null = await this.#classifyFailure(command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async #readByCapabilityHash(capabilityHash: string): Promise<RecipientEnvelopeRow | null> {
		return await this.#database
			.prepare(
				`SELECT recipient.envelope_id AS envelope_id,
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
					envelope.field_generation AS envelope_field_generation
				 FROM recipient
				 INNER JOIN envelope
					ON envelope.id = recipient.envelope_id
				 WHERE recipient.capability_hash = ?
				 LIMIT 1`
			)
			.bind(capabilityHash)
			.first<RecipientEnvelopeRow>();
	}

	async #readRouting(
		envelopeId: string,
		actorId: string,
		actorRoutingOrder: number
	): Promise<SignRoutingSnapshot | null> {
		const result: D1Result<RoutingRecipientRow> = await this.#database
			.prepare(
				`SELECT id, role, routing_order, status FROM recipient
				 WHERE envelope_id = ?`
			)
			.bind(envelopeId)
			.all<RoutingRecipientRow>();
		if (result.results.length < 1 || result.results.length > 50) return null;
		return routingAfterActor(actorId, actorRoutingOrder, result.results);
	}

	async #readAuditHead(envelopeId: string): Promise<SignAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE envelope_id = ? ORDER BY sequence DESC LIMIT 1`
			)
			.bind(envelopeId)
			.first<AuditHeadRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #readFieldDeclarations(
		envelopeId: string,
		recipientId: string
	): Promise<readonly SignableFieldDeclaration[]> {
		const result: D1Result<FieldDeclarationRow> = await this.#database
			.prepare(
				`SELECT id, field_type, required FROM envelope_field
				 WHERE envelope_id = ? AND recipient_id = ?
				 ORDER BY id`
			)
			.bind(envelopeId, recipientId)
			.all<FieldDeclarationRow>();
		return result.results.map((row: FieldDeclarationRow): SignableFieldDeclaration => ({
			id: row.id,
			fieldType: row.field_type,
			required: row.required === 1
		}));
	}

	async #resolveCommand(recipientId: string, key: SignLookupKey): Promise<SignPreparation | null> {
		const exact: SignedCommandRow | null = await this.#readCommandRow(
			recipientId,
			key.idempotencyKey
		);
		if (exact !== null) {
			if (
				exact.envelope_id !== key.expectedEnvelopeId ||
				exact.capability_hash !== key.capabilityHash
			) {
				return { outcome: 'idempotency_conflict' };
			}
			return await this.#evidenceResult(exact);
		}
		const byRecipient: SignedCommandRow | null = await this.#readCommandRowByRecipient(recipientId);
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
		recipientId: string,
		idempotencyKey: string
	): Promise<SignedCommandRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${SIGNED_COMMAND_COLUMNS}
				 FROM recipient_signed_command command
				 LEFT JOIN audit_event evidence
					ON evidence.id = command.audit_event_id
				 LEFT JOIN audit_event completed_evidence
					ON completed_evidence.id = command.completed_audit_event_id
				 WHERE command.actor_type = 'recipient'
					AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(recipientId, idempotencyKey)
			.first<SignedCommandRow>();
	}

	async #readCommandRowByRecipient(recipientId: string): Promise<SignedCommandRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${SIGNED_COMMAND_COLUMNS}
				 FROM recipient_signed_command command
				 LEFT JOIN audit_event evidence
					ON evidence.id = command.audit_event_id
				 LEFT JOIN audit_event completed_evidence
					ON completed_evidence.id = command.completed_audit_event_id
				 WHERE command.recipient_id = ?
				 LIMIT 1`
			)
			.bind(recipientId)
			.first<SignedCommandRow>();
	}

	async #readStoredValues(
		envelopeId: string,
		recipientId: string
	): Promise<readonly StoredSignValue[]> {
		const result: D1Result<{
			field_id: string;
			field_type: FieldType;
			value_json: string;
			value_sha256: string;
		}> = await this.#database
			.prepare(
				`SELECT field_id, field_type, value_json, value_sha256 FROM field_value
				 WHERE envelope_id = ? AND recipient_id = ?
				 ORDER BY field_id`
			)
			.bind(envelopeId, recipientId)
			.all();
		return result.results.map(
			(row: {
				field_id: string;
				field_type: FieldType;
				value_json: string;
				value_sha256: string;
			}): StoredSignValue => ({
				fieldId: row.field_id,
				fieldType: row.field_type,
				valueJson: row.value_json,
				valueSha256: row.value_sha256
			})
		);
	}

	async #evidenceResult(row: SignedCommandRow): Promise<SignPreparation> {
		const stored: readonly StoredSignValue[] = await this.#readStoredValues(
			row.envelope_id,
			row.recipient_id
		);
		const reconstructed: string | null = await reconstructedFingerprint(row, stored);
		if (
			reconstructed === null ||
			!validAuditEvidence(row) ||
			!(await validStoredReceipt(row, stored, reconstructed))
		) {
			return { outcome: 'integrity_error' };
		}
		return {
			outcome: 'existing',
			reconstructedFingerprint: reconstructed,
			result: resultFromRow(row),
			storedFields: stored.map((value: StoredSignValue): SignableFieldDeclaration => ({
				id: value.fieldId,
				fieldType: value.fieldType,
				required: false
			}))
		};
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
		if (
			command.completedAuditEventId !== null &&
			(await this.#hasProcessingDelivery(command.capabilityHash, command.expectedEnvelopeId))
		) {
			return { outcome: 'delivery_in_flight' };
		}
		return null;
	}

	async #hasProcessingDelivery(capabilityHash: string, envelopeId: string): Promise<boolean> {
		const row: { present: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS present FROM delivery_outbox
				 WHERE envelope_id = ? AND status = 'processing' LIMIT 1`
			)
			.bind(envelopeId)
			.first<{ present: number }>();
		return row !== null;
	}

	async #validCompletedProjection(envelopeId: string): Promise<boolean> {
		const row: { valid: number } | null = await this.#database
			.prepare(
				`SELECT CASE WHEN NOT EXISTS (
					SELECT 1 FROM recipient
					WHERE envelope_id = ?
						AND status <> 'completed'
						AND capability_hash IS NOT NULL
						AND capability_revoked_at IS NULL
				) AND NOT EXISTS (
					SELECT 1 FROM delivery_outbox
					WHERE envelope_id = ?
						AND (status IN ('blocked', 'pending', 'processing')
							OR retryable = 1 OR sealed_capability IS NOT NULL)
				) THEN 1 ELSE 0 END AS valid`
			)
			.bind(envelopeId, envelopeId)
			.first<{ valid: number }>();
		return row?.valid === 1;
	}
}

function classifyIdentity(
	row: RecipientEnvelopeRow | null,
	key: SignLookupKey
): SignPreparation | RecipientEnvelopeRow {
	if (row === null) return { outcome: 'not_found' };
	if (row.envelope_id !== key.expectedEnvelopeId || row.recipient_id !== key.expectedRecipientId) {
		return { outcome: 'context_mismatch' };
	}
	if (row.recipient_role !== 'signer') return { outcome: 'role_not_actionable' };
	return row;
}

function isFoundRow(value: SignPreparation | RecipientEnvelopeRow): value is RecipientEnvelopeRow {
	return !('outcome' in value);
}

function liveEligible(row: RecipientEnvelopeRow, capabilityHash: string, at: string): boolean {
	return (
		row.recipient_status === 'viewed' &&
		row.recipient_role === 'signer' &&
		row.recipient_capability_hash === capabilityHash &&
		row.recipient_capability_revoked_at === null &&
		row.recipient_capability_expires_at !== null &&
		new Date(row.recipient_capability_expires_at).getTime() > new Date(at).getTime() &&
		(row.envelope_status === 'sent' || row.envelope_status === 'in_progress') &&
		row.envelope_sent_commit_sha !== null &&
		row.envelope_sent_commit_sha === row.envelope_repository_head
	);
}

function terminalReplay(
	row: RecipientEnvelopeRow,
	capabilityHash: string,
	envelopeStatus: 'in_progress' | 'completed'
): boolean {
	return (
		row.recipient_status === 'completed' &&
		(row.envelope_status === envelopeStatus ||
			(envelopeStatus === 'in_progress' && row.envelope_status === 'completed')) &&
		row.recipient_capability_hash === capabilityHash &&
		row.recipient_capability_revoked_at !== null
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
		.filter(
			(recipient: RoutingRecipientRow): boolean => recipient.routing_order > actorRoutingOrder
		)
		.map((recipient: RoutingRecipientRow): number => recipient.routing_order);
	const nextRoutingOrder: number | null =
		laterOrders.length === 0 ? null : Math.min(...laterOrders);
	return {
		currentGroupOutstanding: remainingActionable.filter(
			(recipient: RoutingRecipientRow): boolean => recipient.routing_order === actorRoutingOrder
		).length,
		remainingActionableOutstanding: remainingActionable.length,
		nextRoutingOrder,
		nextGroupCount:
			nextRoutingOrder === null
				? 0
				: recipients.filter(
						(recipient: RoutingRecipientRow): boolean =>
							recipient.id !== actorId &&
							isPostSendInvitationRecipientRole(recipient.role) &&
							recipient.status !== 'completed' &&
							recipient.routing_order === nextRoutingOrder
					).length
	};
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
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'recipient.signed' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at;
	if (!signedMatches) return false;
	if (row.completed_audit_event_id === null) {
		return (
			row.completed_audit_event_hash === null &&
			row.completed_audit_payload_json === null &&
			row.completed_evidence_event_id === null
		);
	}
	return (
		row.completed_evidence_event_id === row.completed_audit_event_id &&
		row.completed_evidence_envelope_id === row.envelope_id &&
		row.completed_evidence_sequence === row.audit_sequence + 1 &&
		row.completed_evidence_event_type === 'envelope.completed' &&
		row.completed_evidence_actor_type === row.actor_type &&
		row.completed_evidence_actor_id === row.actor_id &&
		row.completed_evidence_payload_json === row.completed_audit_payload_json &&
		row.completed_evidence_previous_hash === row.audit_event_hash &&
		row.completed_evidence_event_hash === row.completed_audit_event_hash &&
		row.completed_evidence_occurred_at === row.updated_at
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
	if (stored.length !== row.field_count) return null;
	for (const value of stored) {
		const digest: string = await sha256(value.valueJson);
		if (digest !== value.valueSha256) return null;
	}
	const values = fingerprintValuesFromStored(stored);
	if (values === null) return null;
	return sha256(
		canonicalRecipientSignFingerprint({
			envelopeId: row.envelope_id,
			recipientId: row.recipient_id,
			capabilityHash: row.capability_hash,
			expectedFieldGeneration: row.expected_field_generation,
			values
		})
	);
}

async function validStoredReceipt(
	row: SignedCommandRow,
	stored: readonly StoredSignValue[],
	reconstructedFingerprint: string
): Promise<boolean> {
	if (reconstructedFingerprint !== row.request_hash) return false;
	const fields: readonly EvidenceField[] | null = parseEvidenceFields(row.field_values_json);
	if (fields === null || fields.length !== row.field_count || fields.length !== stored.length) {
		return false;
	}
	const digestById: Map<string, string> = new Map(
		stored.map((value: StoredSignValue): [string, string] => [value.fieldId, value.valueSha256])
	);
	for (const field of fields) {
		if (digestById.get(field.id) !== field.valueSha256) return false;
	}

	const auditPayloadValue = {
		recipientId: row.recipient_id,
		role: row.recipient_role,
		routingOrder: row.routing_order,
		sentCommitSha: row.sent_commit_sha,
		fields: fields.map((field: EvidenceField) => ({
			id: field.id,
			fieldType: field.fieldType,
			valueSha256: field.valueSha256
		})),
		signedAt: row.updated_at
	};
	const auditPayload: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidence_hash_version,
			sequence: row.audit_sequence,
			eventType: 'recipient.signed',
			actorType: row.actor_type,
			actorId: row.recipient_id,
			occurredAt: row.updated_at,
			payload: auditPayloadValue,
			previousHash: row.previous_audit_hash
		},
		{ envelopeId: row.envelope_id }
	);
	if (auditPayload !== row.audit_payload_json || auditEventHash !== row.audit_event_hash) {
		return false;
	}
	if (row.completed_audit_event_id !== null) {
		if (
			row.next_routing_order !== null ||
			row.next_capability_expires_at !== null ||
			row.released_delivery_count !== 0 ||
			row.completed_audit_event_hash === null ||
			row.completed_audit_payload_json === null
		) {
			return false;
		}
		const completedPayloadValue = {
			sentCommitSha: row.sent_commit_sha,
			completedAt: row.updated_at
		};
		const completedPayload: string = JSON.stringify(completedPayloadValue);
		const completedEventHash: string = await hashStoredAuditEvent(
			{
				hashVersion: row.completed_evidence_hash_version,
				sequence: row.audit_sequence + 1,
				eventType: 'envelope.completed',
				actorType: row.actor_type,
				actorId: row.recipient_id,
				occurredAt: row.updated_at,
				payload: completedPayloadValue,
				previousHash: row.audit_event_hash
			},
			{ envelopeId: row.envelope_id }
		);
		return (
			completedPayload === row.completed_audit_payload_json &&
			completedEventHash === row.completed_audit_event_hash
		);
	}
	if (row.next_routing_order !== null) {
		return (
			row.next_capability_expires_at !== null &&
			row.released_delivery_count > 0 &&
			row.completed_audit_event_hash === null &&
			row.completed_audit_payload_json === null
		);
	}
	return (
		row.next_capability_expires_at === null &&
		row.released_delivery_count === 0 &&
		row.completed_audit_event_hash === null &&
		row.completed_audit_payload_json === null
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
		envelopeId: row.envelope_id,
		recipientId: row.recipient_id,
		recipientRole: 'signer',
		routingOrder: row.routing_order,
		sentCommitSha: row.sent_commit_sha,
		envelopeStatus: row.completed_audit_event_id === null ? 'in_progress' : 'completed',
		signedAt: row.updated_at,
		auditEventId: row.audit_event_id,
		completedAuditEventId: row.completed_audit_event_id,
		nextRoutingOrder: row.next_routing_order
	};
}

function publishFromPreparation(preparation: SignPreparation): PublishRecipientSignedResult {
	if (preparation.outcome === 'ready' || preparation.outcome === 'existing') {
		return { outcome: 'integrity_error' };
	}
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
