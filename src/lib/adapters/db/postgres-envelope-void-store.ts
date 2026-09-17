import postgres from 'postgres';
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

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class EnvelopeVoidIntegrityError extends Error {
	constructor() {
		super('Envelope void publication integrity check failed');
		this.name = 'EnvelopeVoidIntegrityError';
	}
}

interface EnvelopeRow {
	status: string;
	repositoryGeneration: number;
	repositoryHead: string | null;
	sentCommitSha: string | null;
}

interface RecipientLockRow {
	id: string;
	status: string;
	capabilityHash: string | null;
	capabilityRevokedAt: Date | string | null;
}

interface DeliveryLockRow {
	id: string;
	status: string;
	retryable: boolean;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface VoidCommandRow {
	envelopeId: string;
	actorType: string;
	actorId: string;
	idempotencyKey: string;
	requestHash: string;
	previousStatus: VoidableEnvelopeStatus;
	expectedGeneration: number;
	repositoryHead: string | null;
	sentCommitSha: string | null;
	updatedAt: Date | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
	revocationEvidenceVersion: number;
	revokedRecipientIdsJson: string;
	revokedRecipientCount: number | string;
	projectionEnvelopeStatus: string | null;
	projectionGeneration: number | null;
	projectionRepositoryHead: string | null;
	projectionSentCommitSha: string | null;
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

export class PostgresEnvelopeVoidStore implements EnvelopeVoidStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async prepareVoid(key: VoidCommandKey): Promise<VoidPreparation> {
		const replay: VoidPreparation | null = await this.#resolveCommand(this.#sql, key);
		if (replay !== null) return replay;
		const envelope: EnvelopeRow | null = await this.#readEnvelope(this.#sql, key, false);
		if (envelope === null) return { outcome: 'not_found' };
		const classified: VoidPreparation | null = classifyEnvelope(envelope, key);
		if (classified !== null) return classified;
		const deliveryInFlight: boolean = await this.#hasProcessingDelivery(this.#sql, key);
		if (deliveryInFlight) return { outcome: 'delivery_in_flight' };
		const revokedRecipientIds: readonly string[] = await this.#readRevocableRecipientIds(
			this.#sql,
			key
		);
		const auditHead: VoidAuditHead | null = await this.#readAuditHead(this.#sql, key);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return readyPreparation(envelope, auditHead, revokedRecipientIds);
	}

	async publishVoid(command: PublishVoidedEnvelopeCommand): Promise<PublishVoidedEnvelopeResult> {
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishVoidedEnvelopeResult> => {
				const envelope: EnvelopeRow | null = await this.#readEnvelope(transaction, command, true);
				if (envelope === null) return { outcome: 'not_found' };
				const recipients = await transaction<RecipientLockRow[]>`
					SELECT id, status, capability_hash AS "capabilityHash",
						capability_revoked_at AS "capabilityRevokedAt"
					FROM recipient
					WHERE envelope_id = ${command.envelopeId}
					ORDER BY id FOR UPDATE`;
				const replay: VoidPreparation | null = await this.#resolveCommand(transaction, command);
				if (replay !== null) return publishFromPreparation(replay);
				const classified: VoidPreparation | null = classifyEnvelope(envelope, command);
				if (classified !== null) return publishFromPreparation(classified);
				if (
					envelope.repositoryHead !== command.repositoryHead ||
					envelope.sentCommitSha !== command.sentCommitSha
				) {
					return { outcome: 'integrity_error' };
				}
				const revokedRecipientIds: readonly string[] = recipients
					.filter(
						(recipient: RecipientLockRow): boolean =>
							recipient.status !== 'completed' &&
							recipient.capabilityHash !== null &&
							recipient.capabilityRevokedAt === null
					)
					.map((recipient: RecipientLockRow): string => recipient.id);
				if (!sameStringArray(revokedRecipientIds, command.revokedRecipientIds)) {
					return { outcome: 'integrity_error' };
				}
				const deliveries = await transaction<DeliveryLockRow[]>`
					SELECT id, status, retryable FROM delivery_outbox
					WHERE envelope_id = ${command.envelopeId}
					ORDER BY id FOR UPDATE`;
				if (
					deliveries.some((delivery: DeliveryLockRow): boolean => delivery.status === 'processing')
				) {
					return { outcome: 'delivery_in_flight' };
				}
				const auditHead: VoidAuditHead | null = await this.#readAuditHead(
					transaction,
					command,
					true
				);
				if (auditHead === null) return { outcome: 'integrity_error' };
				if (
					auditHead.sequence !== command.expectedAuditSequence ||
					auditHead.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'audit_conflict' };
				}

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
						sealed_capability = NULL,
						available_at = COALESCE(available_at, ${command.updatedAt}::timestamptz),
						last_error = 'envelope_terminal', updated_at = ${command.updatedAt}::timestamptz
					WHERE envelope_id = ${command.envelopeId}
						AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable))
					RETURNING id`;
				const cleanedIds: readonly string[] = cleanedRows
					.map((row: { id: string }): string => row.id)
					.sort();
				if (!sameStringArray(cleanedIds, expectedCleanupIds))
					throw new EnvelopeVoidIntegrityError();

				const revokedRows = await transaction<{ id: string }[]>`
					UPDATE recipient SET capability_revoked_at = ${command.updatedAt}::timestamptz,
						updated_at = ${command.updatedAt}::timestamptz
					WHERE envelope_id = ${command.envelopeId}
						AND status <> 'completed' AND capability_hash IS NOT NULL
						AND capability_revoked_at IS NULL
					RETURNING id`;
				const revokedIds: readonly string[] = revokedRows
					.map((row: { id: string }): string => row.id)
					.sort();
				if (!sameStringArray(revokedIds, command.revokedRecipientIds)) {
					throw new EnvelopeVoidIntegrityError();
				}

				const envelopeRows = await transaction<{ id: string }[]>`
					UPDATE envelope SET status = 'voided', updated_at = ${command.updatedAt}::timestamptz
					WHERE id = ${command.envelopeId}
						AND status = ${command.expectedStatus}
						AND repository_generation = ${command.expectedGeneration}
						AND repository_head IS NOT DISTINCT FROM ${command.repositoryHead}
						AND sent_commit_sha IS NOT DISTINCT FROM ${command.sentCommitSha}
					RETURNING id`;
				if (envelopeRows.length !== 1) throw new EnvelopeVoidIntegrityError();

				await transaction`
					INSERT INTO envelope_void_command (
						envelope_id, actor_type, actor_id, idempotency_key, request_hash,
						previous_status, expected_generation, repository_head, sent_commit_sha,
						updated_at, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json, revocation_evidence_version,
						revoked_recipient_ids_json, revoked_recipient_count
					) VALUES (${command.envelopeId}, ${command.actorType},
						${command.actorId}, ${command.idempotencyKey}, ${command.requestFingerprint},
						${command.expectedStatus}, ${command.expectedGeneration}, ${command.repositoryHead},
						${command.sentCommitSha}, ${command.updatedAt}::timestamptz, ${command.auditEventId},
						${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.auditPayloadJson}, 1,
						${JSON.stringify(command.revokedRecipientIds)}, ${command.revokedRecipientIds.length})`;
				await transaction`
					INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at
					) VALUES (${command.auditEventId}, ${command.envelopeId},
						${command.expectedAuditSequence + 1}, 'envelope.voided', ${command.actorType},
						${command.actorId}, ${command.auditPayloadJson}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.updatedAt}::timestamptz)`;
				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: VoidPreparation = await this.prepareVoid(command);
			if (classified.outcome !== 'ready') return publishFromPreparation(classified);
			if (
				classified.auditHead.sequence !== command.expectedAuditSequence ||
				classified.auditHead.eventHash !== command.previousAuditHash
			) {
				return { outcome: 'audit_conflict' };
			}
			throw error;
		}
	}

	async #readEnvelope(sql: Sql, key: VoidCommandKey, lock: boolean): Promise<EnvelopeRow | null> {
		const rows = lock
			? await sql<EnvelopeRow[]>`
				SELECT status, repository_generation AS "repositoryGeneration",
					repository_head AS "repositoryHead", sent_commit_sha AS "sentCommitSha"
				FROM envelope WHERE id = ${key.envelopeId}
				FOR UPDATE`
			: await sql<EnvelopeRow[]>`
				SELECT status, repository_generation AS "repositoryGeneration",
					repository_head AS "repositoryHead", sent_commit_sha AS "sentCommitSha"
				FROM envelope WHERE id = ${key.envelopeId}`;
		return rows[0] ?? null;
	}

	async #readRevocableRecipientIds(sql: Sql, key: VoidCommandKey): Promise<readonly string[]> {
		const rows = await sql<{ id: string }[]>`
			SELECT id FROM recipient WHERE envelope_id = ${key.envelopeId} AND status <> 'completed'
				AND capability_hash IS NOT NULL AND capability_revoked_at IS NULL ORDER BY id`;
		return rows.map((row: { id: string }): string => row.id);
	}

	async #hasProcessingDelivery(sql: Sql, key: VoidCommandKey): Promise<boolean> {
		const rows = await sql<{ active: boolean }[]>`
			SELECT EXISTS (SELECT 1 FROM delivery_outbox WHERE envelope_id = ${key.envelopeId} AND status = 'processing') AS active`;
		return rows[0]?.active ?? false;
	}

	async #readAuditHead(
		sql: Sql,
		key: VoidCommandKey,
		lock: boolean = false
	): Promise<VoidAuditHead | null> {
		const rows = lock
			? await sql<AuditHeadRow[]>`
				SELECT sequence, event_hash AS "eventHash" FROM audit_event
				WHERE envelope_id = ${key.envelopeId}
				ORDER BY sequence DESC LIMIT 1 FOR UPDATE`
			: await sql<AuditHeadRow[]>`
				SELECT sequence, event_hash AS "eventHash" FROM audit_event
				WHERE envelope_id = ${key.envelopeId}
				ORDER BY sequence DESC LIMIT 1`;
		const row: AuditHeadRow | undefined = rows[0];
		return row === undefined ? null : { sequence: Number(row.sequence), eventHash: row.eventHash };
	}

	async #resolveCommand(sql: Sql, key: VoidCommandKey): Promise<VoidPreparation | null> {
		const rows = await sql<VoidCommandRow[]>`
			SELECT command.envelope_id AS "envelopeId",
				command.actor_type AS "actorType", command.actor_id AS "actorId",
				command.idempotency_key AS "idempotencyKey", command.request_hash AS "requestHash",
				command.previous_status AS "previousStatus", command.expected_generation AS "expectedGeneration",
				command.repository_head AS "repositoryHead", command.sent_commit_sha AS "sentCommitSha",
				command.updated_at AS "updatedAt", command.audit_event_id AS "auditEventId",
				command.audit_sequence AS "auditSequence", command.previous_audit_hash AS "previousAuditHash",
				command.audit_event_hash AS "auditEventHash", command.audit_payload_json AS "auditPayloadJson",
				command.revocation_evidence_version AS "revocationEvidenceVersion",
				command.revoked_recipient_ids_json AS "revokedRecipientIdsJson",
				command.revoked_recipient_count AS "revokedRecipientCount",
				envelope.status AS "projectionEnvelopeStatus",
				envelope.repository_generation AS "projectionGeneration",
				envelope.repository_head AS "projectionRepositoryHead",
				envelope.sent_commit_sha AS "projectionSentCommitSha",
				ARRAY(SELECT recipient.id FROM recipient
					WHERE recipient.envelope_id = command.envelope_id
						AND recipient.status <> 'completed' AND recipient.capability_hash IS NOT NULL
						AND recipient.capability_revoked_at = command.updated_at ORDER BY recipient.id
				) AS "projectionRevokedRecipientIds",
				EXISTS (SELECT 1 FROM recipient
					WHERE recipient.envelope_id = command.envelope_id
						AND recipient.status <> 'completed' AND recipient.capability_hash IS NOT NULL
						AND recipient.capability_revoked_at IS NULL
				) AS "projectionHasRevocableRecipient",
				EXISTS (SELECT 1 FROM delivery_outbox delivery
					WHERE delivery.envelope_id = command.envelope_id
						AND (delivery.status IN ('blocked', 'pending', 'processing')
							OR delivery.retryable OR delivery.sealed_capability IS NOT NULL)
				) AS "projectionHasUnsafeDelivery",
				evidence.id AS "evidenceEventId",
				evidence.envelope_id AS "evidenceEnvelopeId", evidence.sequence AS "evidenceSequence",
				evidence.event_type AS "evidenceEventType", evidence.actor_type AS "evidenceActorType",
				evidence.actor_id AS "evidenceActorId", evidence.payload_json AS "evidencePayloadJson",
				evidence.previous_hash AS "evidencePreviousHash", evidence.event_hash AS "evidenceEventHash",
				evidence.occurred_at AS "evidenceOccurredAt", evidence.hash_version AS "evidenceHashVersion"
			FROM envelope_void_command command
			LEFT JOIN envelope ON envelope.id = command.envelope_id
			LEFT JOIN audit_event evidence ON evidence.id = command.audit_event_id
			WHERE command.actor_type = ${key.actorType}
				AND command.actor_id = ${key.actorId} AND command.idempotency_key = ${key.idempotencyKey}
			LIMIT 1`;
		const row: VoidCommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (
			row.envelopeId !== key.envelopeId ||
			row.requestHash !== key.requestFingerprint ||
			row.previousStatus !== key.expectedStatus ||
			row.expectedGeneration !== key.expectedGeneration
		) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!(await validReplay(row))) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}
}

function classifyEnvelope(envelope: EnvelopeRow, key: VoidCommandKey): VoidPreparation | null {
	if (!isVoidableStatus(envelope.status)) return { outcome: 'not_voidable' };
	if (envelope.status !== key.expectedStatus) return { outcome: 'status_conflict' };
	if (envelope.repositoryGeneration !== key.expectedGeneration)
		return { outcome: 'generation_conflict' };
	return null;
}

function readyPreparation(
	envelope: EnvelopeRow,
	auditHead: VoidAuditHead,
	revokedRecipientIds: readonly string[]
): Extract<VoidPreparation, { outcome: 'ready' }> {
	return {
		outcome: 'ready',
		previousStatus: envelope.status as VoidableEnvelopeStatus,
		generation: envelope.repositoryGeneration,
		repositoryHead: envelope.repositoryHead,
		sentCommitSha: envelope.sentCommitSha,
		auditHead,
		revokedRecipientIds
	};
}

async function validReplay(row: VoidCommandRow): Promise<boolean> {
	const revokedRecipientIds: readonly string[] | null = parseRevokedRecipientIds(row);
	if (revokedRecipientIds === null) return false;
	const voidedAt: string = isoTimestamp(row.updatedAt);
	const payloadValue = {
		previousStatus: row.previousStatus,
		generation: row.expectedGeneration,
		repositoryHead: row.repositoryHead,
		sentCommitSha: row.sentCommitSha,
		voidedAt,
		revokedCapabilities: { reason: 'envelope_voided', recipientIds: revokedRecipientIds }
	};
	const requestHash: string = await sha256(
		JSON.stringify({
			expectedStatus: row.previousStatus,
			expectedGeneration: row.expectedGeneration
		})
	);
	const auditPayloadJson: string = JSON.stringify(payloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: Number(row.auditSequence),
			eventType: 'envelope.voided',
			actorType: row.actorType,
			actorId: row.actorId,
			occurredAt: voidedAt,
			payload: payloadValue,
			previousHash: row.previousAuditHash
		},
		{ envelopeId: row.envelopeId }
	);
	return (
		requestHash === row.requestHash &&
		auditPayloadJson === row.auditPayloadJson &&
		auditEventHash === row.auditEventHash &&
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'envelope.voided' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt) &&
		row.projectionEnvelopeStatus === 'voided' &&
		row.projectionGeneration === row.expectedGeneration &&
		row.projectionRepositoryHead === row.repositoryHead &&
		row.projectionSentCommitSha === row.sentCommitSha &&
		sameStringArray(row.projectionRevokedRecipientIds, revokedRecipientIds) &&
		!row.projectionHasRevocableRecipient &&
		!row.projectionHasUnsafeDelivery
	);
}

function parseRevokedRecipientIds(row: VoidCommandRow): readonly string[] | null {
	if (row.revocationEvidenceVersion !== 1) return null;
	try {
		const value: unknown = JSON.parse(row.revokedRecipientIdsJson);
		if (
			!Array.isArray(value) ||
			!value.every((item: unknown): item is string => typeof item === 'string')
		) {
			return null;
		}
		const ids: string[] = [...value];
		const sorted: string[] = [...ids].sort();
		return ids.length === Number(row.revokedRecipientCount) &&
			sameStringArray(ids, sorted) &&
			new Set(ids).size === ids.length
			? ids
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
		left.every((value: string, index: number): boolean => value === right[index])
	);
}

function sameTimestamp(left: Date | string | null, right: Date | string): boolean {
	return left !== null && new Date(left).getTime() === new Date(right).getTime();
}

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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
		envelopeId: row.envelopeId,
		status: 'voided',
		previousStatus: row.previousStatus,
		generation: row.expectedGeneration,
		voidedAt: isoTimestamp(row.updatedAt),
		revokedCapabilityCount: Number(row.revokedRecipientCount),
		auditEventId: row.auditEventId
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
