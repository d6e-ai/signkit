import postgres from 'postgres';
import type {
	PublishReissueCommand,
	PublishReissueResult,
	RecipientCapabilityReissueStore,
	ReissueAuditHead,
	ReissueCommandKey,
	ReissuePreparation
} from '$lib/ports/recipient-capability-reissue-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class ReissuePublicationIntegrityError extends Error {
	constructor(message: string = 'Recipient capability reissue publication integrity check failed') {
		super(message);
		this.name = 'ReissuePublicationIntegrityError';
	}
}

interface EnvelopeRow {
	status: string;
}

interface RecipientRow {
	status: string;
	capabilityHash: string | null;
	capabilityExpiresAt: Date | string | null;
	capabilityRevokedAt: Date | string | null;
}

interface OutboxRow {
	id: string;
	status: string;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface CommandRow {
	envelopeId: string;
	recipientId: string;
	actorType: string;
	actorId: string;
	idempotencyKey: string;
	requestHash: string;
	newCapabilityHash: string;
	outboxId: string;
	updatedAt: Date | string;
	auditEventId: string;
}

export class PostgresRecipientCapabilityReissueStore implements RecipientCapabilityReissueStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async prepareReissue(key: ReissueCommandKey, at: string): Promise<ReissuePreparation> {
		void at;
		const replay: ReissuePreparation | null = await this.#resolveCommand(this.#sql, key);
		if (replay !== null) return replay;

		const envelope: EnvelopeRow | null = await this.#readEnvelope(this.#sql, key.envelopeId, false);
		if (envelope === null) return { outcome: 'not_found' };
		if (
			envelope.status === 'voided' ||
			envelope.status === 'completed' ||
			envelope.status === 'expired'
		) {
			return { outcome: 'not_eligible', reason: 'envelope_terminal' };
		}
		if (envelope.status !== 'sent' && envelope.status !== 'in_progress') {
			return { outcome: 'not_eligible', reason: 'envelope_not_sent' };
		}

		const recipient: RecipientRow | null = await this.#readRecipient(
			this.#sql,
			key.envelopeId,
			key.recipientId,
			false
		);
		if (recipient === null) return { outcome: 'not_found' };
		if (recipient.status === 'completed' || recipient.status === 'declined') {
			return { outcome: 'not_eligible', reason: 'recipient_terminal' };
		}
		if (recipient.status !== 'pending' && recipient.status !== 'viewed') {
			return { outcome: 'not_eligible', reason: 'recipient_terminal' };
		}
		if (
			recipient.capabilityExpiresAt === null ||
			recipient.capabilityHash === null ||
			recipient.capabilityRevokedAt !== null
		) {
			return { outcome: 'not_eligible', reason: 'not_released' };
		}

		const outbox: OutboxRow[] = await this.#readOutbox(
			this.#sql,
			key.envelopeId,
			key.recipientId,
			false
		);
		if (outbox.some((row: OutboxRow): boolean => row.status === 'processing')) {
			return { outcome: 'delivery_in_flight' };
		}
		if (outbox.some((row: OutboxRow): boolean => row.status === 'blocked')) {
			return { outcome: 'not_eligible', reason: 'not_released' };
		}

		const auditHead: ReissueAuditHead | null = await this.#readAuditHead(this.#sql, key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };

		return {
			outcome: 'ready',
			previousCapabilityHash: recipient.capabilityHash,
			recipientStatus: recipient.status as 'pending' | 'viewed',
			envelopeStatus: envelope.status as 'sent' | 'in_progress',
			auditHead
		};
	}

	async publishReissue(command: PublishReissueCommand): Promise<PublishReissueResult> {
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishReissueResult> => {
				// Lock envelope, recipient, and outbox in stable order
				const envelope: EnvelopeRow | null = await this.#readEnvelope(
					transaction,
					command.envelopeId,
					true
				);
				if (envelope === null) return { outcome: 'not_found' };
				if (
					envelope.status === 'voided' ||
					envelope.status === 'completed' ||
					envelope.status === 'expired'
				) {
					return { outcome: 'not_eligible', reason: 'envelope_terminal' };
				}
				if (envelope.status !== 'sent' && envelope.status !== 'in_progress') {
					return { outcome: 'not_eligible', reason: 'envelope_not_sent' };
				}

				const recipient: RecipientRow | null = await this.#readRecipient(
					transaction,
					command.envelopeId,
					command.recipientId,
					true
				);
				if (recipient === null) return { outcome: 'not_found' };
				if (recipient.status === 'completed' || recipient.status === 'declined') {
					return { outcome: 'not_eligible', reason: 'recipient_terminal' };
				}
				if (recipient.status !== 'pending' && recipient.status !== 'viewed') {
					return { outcome: 'not_eligible', reason: 'recipient_terminal' };
				}
				if (
					recipient.capabilityExpiresAt === null ||
					recipient.capabilityHash === null ||
					recipient.capabilityHash !== command.previousCapabilityHash ||
					recipient.capabilityRevokedAt !== null
				) {
					return { outcome: 'not_eligible', reason: 'not_released' };
				}

				const outbox: OutboxRow[] = await this.#readOutbox(
					transaction,
					command.envelopeId,
					command.recipientId,
					true
				);
				if (outbox.some((row: OutboxRow): boolean => row.status === 'processing')) {
					return { outcome: 'delivery_in_flight' };
				}
				if (outbox.some((row: OutboxRow): boolean => row.status === 'blocked')) {
					return { outcome: 'not_eligible', reason: 'not_released' };
				}

				const replay: ReissuePreparation | null = await this.#resolveCommand(transaction, command);
				if (replay !== null) return publishFromPreparation(replay);

				const auditHead: ReissueAuditHead | null = await this.#readAuditHead(
					transaction,
					command.envelopeId
				);
				if (auditHead === null) return { outcome: 'integrity_error' };
				if (
					auditHead.sequence !== command.expectedAuditSequence ||
					auditHead.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'audit_conflict' };
				}

				// 1. Supersede predecessor in issuance ledger
				await transaction`
					UPDATE recipient_capability_issuance
					SET superseded_at = ${command.updatedAt}
					WHERE recipient_id = ${command.recipientId}
						AND capability_hash = ${command.previousCapabilityHash}`;

				// 2. Insert new capability into issuance ledger
				await transaction`
					INSERT INTO recipient_capability_issuance (
						envelope_id, recipient_id, capability_hash, predecessor_capability_hash, issued_at
					) VALUES (
						${command.envelopeId}, ${command.recipientId},
						${command.newCapabilityHash}, ${command.previousCapabilityHash}, ${command.updatedAt}
					)`;

				// 3. Update recipient capability
				const updatedRecipient = await transaction<{ id: string }[]>`
					UPDATE recipient
					SET capability_hash = ${command.newCapabilityHash},
						capability_expires_at = ${command.reservedCapabilityExpiresAt},
						capability_revoked_at = NULL,
						updated_at = ${command.updatedAt}
					WHERE envelope_id = ${command.envelopeId}
						AND id = ${command.recipientId}
					RETURNING id`;
				if (updatedRecipient.length !== 1) throw new ReissuePublicationIntegrityError();

				// 4. Supersede old pending/failed delivery outbox row(s)
				await transaction`
					UPDATE delivery_outbox
					SET status = 'failed',
						claim_token = NULL,
						locked_at = NULL,
						retryable = false,
						sealed_capability = NULL,
						last_error = 'capability_superseded',
						updated_at = ${command.updatedAt}
					WHERE envelope_id = ${command.envelopeId}
						AND recipient_id = ${command.recipientId}
						AND (status = 'pending' OR (status = 'failed' AND retryable = true))`;

				// 5. Insert new outbox row
				await transaction`
					INSERT INTO delivery_outbox (
						id, envelope_id, recipient_id, kind, status,
						capability_hash, reserved_capability_expires_at, sealed_capability,
						sealing_key_id, sealed_capability_sha256, available_at, attempts,
						created_at, updated_at, retryable
					) VALUES (
						${command.outboxId}, ${command.envelopeId}, ${command.recipientId},
						'recipient_invitation', 'pending', ${command.newCapabilityHash},
						${command.reservedCapabilityExpiresAt}, ${command.sealedCapability},
						${command.sealingKeyId}, ${command.sealedCapabilitySha256}, ${command.updatedAt}, 0,
						${command.updatedAt}, ${command.updatedAt}, true
					)`;

				// 6. Insert reissue command record
				await transaction`
					INSERT INTO recipient_capability_reissue_command (
						envelope_id, recipient_id, actor_type, actor_id,
						idempotency_key, request_hash, previous_capability_hash, new_capability_hash,
						reserved_capability_expires_at, sealed_capability, sealing_key_id,
						sealed_capability_sha256, outbox_id, reason, updated_at,
						audit_event_id, audit_sequence, previous_audit_hash, audit_event_hash,
						audit_payload_json
					) VALUES (
						${command.envelopeId}, ${command.recipientId},
						${command.actorType}, ${command.actorId}, ${command.idempotencyKey},
						${command.requestHash}, ${command.previousCapabilityHash}, ${command.newCapabilityHash},
						${command.reservedCapabilityExpiresAt}, ${command.sealedCapability},
						${command.sealingKeyId}, ${command.sealedCapabilitySha256}, ${command.outboxId},
						${command.reason}, ${command.updatedAt}, ${command.auditEventId},
						${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.auditPayloadJson}
					)`;

				// 7. Insert audit event
				await transaction`
					INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type,
						actor_id, payload_json, previous_hash, event_hash, occurred_at
					) VALUES (
						${command.auditEventId}, ${command.envelopeId},
						${command.expectedAuditSequence + 1}, 'recipient.capability_reissued',
						${command.actorType}, ${command.actorId}, ${command.auditPayloadJson},
						${command.previousAuditHash}, ${command.auditEventHash}, ${command.updatedAt}
					)`;

				// 8. Update envelope updated_at
				await transaction`
					UPDATE envelope
					SET updated_at = ${command.updatedAt}
					WHERE id = ${command.envelopeId}`;

				return {
					outcome: 'published',
					result: {
						envelopeId: command.envelopeId,
						recipientId: command.recipientId,
						newCapabilityHash: command.newCapabilityHash,
						outboxId: command.outboxId,
						reissuedAt: command.updatedAt,
						auditEventId: command.auditEventId
					}
				};
			});
		} catch (error: unknown) {
			const preparation = await this.prepareReissue(command, command.updatedAt);
			if (preparation.outcome !== 'ready') return preparation;
			if (error instanceof ReissuePublicationIntegrityError) return { outcome: 'integrity_error' };
			throw error;
		}
	}

	async #readEnvelope(sql: Sql, envelopeId: string, lock: boolean): Promise<EnvelopeRow | null> {
		const rows = lock
			? await sql<EnvelopeRow[]>`
				SELECT status FROM envelope
				WHERE id = ${envelopeId}
				FOR UPDATE`
			: await sql<EnvelopeRow[]>`
				SELECT status FROM envelope
				WHERE id = ${envelopeId}
				LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readRecipient(
		sql: Sql,
		envelopeId: string,
		recipientId: string,
		lock: boolean
	): Promise<RecipientRow | null> {
		const rows = lock
			? await sql<RecipientRow[]>`
				SELECT status, capability_hash AS "capabilityHash",
					capability_expires_at AS "capabilityExpiresAt",
					capability_revoked_at AS "capabilityRevokedAt"
				FROM recipient
				WHERE envelope_id = ${envelopeId} AND id = ${recipientId}
				FOR UPDATE`
			: await sql<RecipientRow[]>`
				SELECT status, capability_hash AS "capabilityHash",
					capability_expires_at AS "capabilityExpiresAt",
					capability_revoked_at AS "capabilityRevokedAt"
				FROM recipient
				WHERE envelope_id = ${envelopeId} AND id = ${recipientId}
				LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readOutbox(
		sql: Sql,
		envelopeId: string,
		recipientId: string,
		lock: boolean
	): Promise<OutboxRow[]> {
		return lock
			? await sql<OutboxRow[]>`
				SELECT id, status FROM delivery_outbox
				WHERE envelope_id = ${envelopeId} AND recipient_id = ${recipientId}
				FOR UPDATE`
			: await sql<OutboxRow[]>`
				SELECT id, status FROM delivery_outbox
				WHERE envelope_id = ${envelopeId} AND recipient_id = ${recipientId}`;
	}

	async #readAuditHead(sql: Sql, envelopeId: string): Promise<ReissueAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash"
			FROM audit_event
			WHERE envelope_id = ${envelopeId}
			ORDER BY sequence DESC
			LIMIT 1`;
		const row = rows[0];
		if (row === undefined) return null;
		const sequence = Number(row.sequence);
		if (!Number.isSafeInteger(sequence) || sequence < 1 || row.eventHash.length === 0) return null;
		return { sequence, eventHash: row.eventHash };
	}

	async #resolveCommand(sql: Sql, key: ReissueCommandKey): Promise<ReissuePreparation | null> {
		const rows = await sql<CommandRow[]>`
			SELECT envelope_id AS "envelopeId",
				recipient_id AS "recipientId", actor_type AS "actorType", actor_id AS "actorId",
				idempotency_key AS "idempotencyKey", request_hash AS "requestHash",
				new_capability_hash AS "newCapabilityHash", outbox_id AS "outboxId",
				updated_at AS "updatedAt", audit_event_id AS "auditEventId"
			FROM recipient_capability_reissue_command
			WHERE actor_type = ${key.actorType}
				AND actor_id = ${key.actorId}
				AND idempotency_key = ${key.idempotencyKey}
			LIMIT 1`;
		const row = rows[0];
		if (row === undefined) return null;
		if (
			row.envelopeId !== key.envelopeId ||
			row.recipientId !== key.recipientId ||
			row.requestHash !== key.requestHash
		) {
			return { outcome: 'idempotency_conflict' };
		}
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelopeId,
				recipientId: row.recipientId,
				newCapabilityHash: row.newCapabilityHash,
				outboxId: row.outboxId,
				reissuedAt: isoTimestamp(row.updatedAt),
				auditEventId: row.auditEventId
			}
		};
	}
}

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function publishFromPreparation(preparation: ReissuePreparation): PublishReissueResult {
	return preparation.outcome === 'ready' ? { outcome: 'integrity_error' } : preparation;
}
