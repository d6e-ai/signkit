import type {
	PublishReissueCommand,
	PublishReissueResult,
	RecipientCapabilityReissueStore,
	ReissueAuditHead,
	ReissueCommandKey,
	ReissuePreparation
} from '$lib/ports/recipient-capability-reissue-store';

interface EnvelopeRow {
	status: string;
}

interface RecipientRow {
	status: string;
	capability_hash: string | null;
	capability_expires_at: string | null;
	capability_revoked_at: string | null;
}

interface OutboxRow {
	id: string;
	status: string;
}

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

interface CommandRow {
	envelope_id: string;
	recipient_id: string;
	actor_type: string;
	actor_id: string;
	idempotency_key: string;
	request_hash: string;
	new_capability_hash: string;
	outbox_id: string;
	updated_at: string;
	audit_event_id: string;
}

export class D1RecipientCapabilityReissueStore implements RecipientCapabilityReissueStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async prepareReissue(key: ReissueCommandKey, at: string): Promise<ReissuePreparation> {
		void at;
		const replay: ReissuePreparation | null = await this.#resolveCommand(key);
		if (replay !== null) return replay;

		const envelope: EnvelopeRow | null = await this.#database
			.prepare('SELECT status FROM envelope WHERE id = ? LIMIT 1')
			.bind(key.envelopeId)
			.first<EnvelopeRow>();
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

		const recipient: RecipientRow | null = await this.#database
			.prepare(
				`SELECT status, capability_hash, capability_expires_at, capability_revoked_at
				 FROM recipient
				 WHERE envelope_id = ? AND id = ?
				 LIMIT 1`
			)
			.bind(key.envelopeId, key.recipientId)
			.first<RecipientRow>();
		if (recipient === null) return { outcome: 'not_found' };
		if (recipient.status === 'completed' || recipient.status === 'declined') {
			return { outcome: 'not_eligible', reason: 'recipient_terminal' };
		}
		if (recipient.status !== 'pending' && recipient.status !== 'viewed') {
			return { outcome: 'not_eligible', reason: 'recipient_terminal' };
		}
		if (
			recipient.capability_expires_at === null ||
			recipient.capability_hash === null ||
			recipient.capability_revoked_at !== null
		) {
			return { outcome: 'not_eligible', reason: 'not_released' };
		}

		const outboxResult = await this.#database
			.prepare(
				`SELECT id, status FROM delivery_outbox
				 WHERE envelope_id = ? AND recipient_id = ?`
			)
			.bind(key.envelopeId, key.recipientId)
			.all<OutboxRow>();
		const outbox: OutboxRow[] = outboxResult.results ?? [];
		if (outbox.some((row: OutboxRow): boolean => row.status === 'processing')) {
			return { outcome: 'delivery_in_flight' };
		}
		if (outbox.some((row: OutboxRow): boolean => row.status === 'blocked')) {
			return { outcome: 'not_eligible', reason: 'not_released' };
		}

		const auditHead: ReissueAuditHead | null = await this.#readAuditHead(key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };

		return {
			outcome: 'ready',
			previousCapabilityHash: recipient.capability_hash,
			recipientStatus: recipient.status as 'pending' | 'viewed',
			envelopeStatus: envelope.status as 'sent' | 'in_progress',
			auditHead
		};
	}

	async publishReissue(command: PublishReissueCommand): Promise<PublishReissueResult> {
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO recipient_capability_reissue_command (
					envelope_id, recipient_id, actor_type, actor_id,
					idempotency_key, request_hash, previous_capability_hash, new_capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, outbox_id, reason, updated_at,
					audit_event_id, audit_sequence, previous_audit_hash, audit_event_hash,
					audit_payload_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.envelopeId,
				command.recipientId,
				command.actorType,
				command.actorId,
				command.idempotencyKey,
				command.requestHash,
				command.previousCapabilityHash,
				command.newCapabilityHash,
				command.reservedCapabilityExpiresAt,
				command.sealedCapability,
				command.sealingKeyId,
				command.sealedCapabilitySha256,
				command.outboxId,
				command.reason,
				command.updatedAt,
				command.auditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventHash,
				command.auditPayloadJson
			);

		try {
			await this.#database.batch([statement]);
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
		} catch (error: unknown) {
			const preparation: ReissuePreparation = await this.prepareReissue(command, command.updatedAt);
			if (preparation.outcome !== 'ready') return preparation;
			if (
				preparation.auditHead.sequence !== command.expectedAuditSequence ||
				preparation.auditHead.eventHash !== command.previousAuditHash
			) {
				return { outcome: 'audit_conflict' };
			}
			throw error;
		}
	}

	async #readAuditHead(envelopeId: string): Promise<ReissueAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash
				 FROM audit_event
				 WHERE envelope_id = ?
				 ORDER BY sequence DESC
				 LIMIT 1`
			)
			.bind(envelopeId)
			.first<AuditHeadRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #resolveCommand(key: ReissueCommandKey): Promise<ReissuePreparation | null> {
		const row: CommandRow | null = await this.#database
			.prepare(
				`SELECT envelope_id, recipient_id, actor_type, actor_id,
					idempotency_key, request_hash, new_capability_hash, outbox_id,
					updated_at, audit_event_id
				 FROM recipient_capability_reissue_command
				 WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?
				 LIMIT 1`
			)
			.bind(key.actorType, key.actorId, key.idempotencyKey)
			.first<CommandRow>();
		if (row === null) return null;
		if (
			row.envelope_id !== key.envelopeId ||
			row.recipient_id !== key.recipientId ||
			row.request_hash !== key.requestHash
		) {
			return { outcome: 'idempotency_conflict' };
		}
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelope_id,
				recipientId: row.recipient_id,
				newCapabilityHash: row.new_capability_hash,
				outboxId: row.outbox_id,
				reissuedAt: row.updated_at,
				auditEventId: row.audit_event_id
			}
		};
	}
}
