import { isPostSendInvitationRecipientRole, type RecipientRole } from '$lib/domain/envelope';
import type {
	PublishRecipientViewedCommand,
	PublishRecipientViewedResult,
	PublishedRecipientViewed,
	RecipientViewStore,
	ViewedAuditHead,
	ViewedCommandKey,
	ViewedPreparation
} from '$lib/ports/recipient-view-store';

interface RecipientEnvelopeRow {
	recipient_role: RecipientRole;
	recipient_status: string;
	recipient_capability_hash: string | null;
	recipient_capability_expires_at: string | null;
	recipient_capability_revoked_at: string | null;
	routing_order: number;
	envelope_status: string;
	envelope_sent_commit_sha: string | null;
	envelope_repository_head: string | null;
}

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

interface ViewedCommandRow {
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
}

const VIEWED_COMMAND_COLUMNS: string = `command.envelope_id, command.recipient_id,
	command.recipient_role, command.routing_order, command.actor_type, command.actor_id,
	command.idempotency_key, command.request_hash, command.capability_hash, command.sent_commit_sha,
	command.updated_at, command.audit_event_id, command.audit_sequence, command.previous_audit_hash,
	command.audit_event_hash, command.audit_payload_json,
	evidence.id AS evidence_event_id, evidence.envelope_id AS evidence_envelope_id, evidence.sequence AS evidence_sequence,
	evidence.event_type AS evidence_event_type, evidence.actor_type AS evidence_actor_type,
	evidence.actor_id AS evidence_actor_id, evidence.payload_json AS evidence_payload_json,
	evidence.previous_hash AS evidence_previous_hash, evidence.event_hash AS evidence_event_hash,
	evidence.occurred_at AS evidence_occurred_at`;

export class D1RecipientViewStore implements RecipientViewStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async prepareViewed(key: ViewedCommandKey, at: string): Promise<ViewedPreparation> {
		const row: RecipientEnvelopeRow | null = await this.#readRecipientEnvelope(
			key.envelopeId,
			key.recipientId
		);
		if (row === null || !authorized(row, key.capabilityHash, at)) return { outcome: 'not_found' };
		const replay: ViewedPreparation | null = await this.#resolveCommand(key);
		if (replay !== null) {
			if (replay.outcome !== 'replayed') return replay;
			const current: RecipientEnvelopeRow | null = await this.#readRecipientEnvelope(
				key.envelopeId,
				key.recipientId
			);
			if (current === null || !authorized(current, key.capabilityHash, at)) {
				return { outcome: 'not_found' };
			}
			if (current.recipient_status !== 'viewed' || current.envelope_status !== 'in_progress') {
				return { outcome: 'integrity_error' };
			}
			return replay;
		}
		if (row.recipient_status === 'viewed') {
			const viewedCommand: ViewedCommandRow | null = await this.#readCommandRowByRecipient(
				key.recipientId
			);
			if (
				viewedCommand === null ||
				!validAuditEvidence(viewedCommand) ||
				!(await validStoredReceipt(viewedCommand))
			) {
				return { outcome: 'integrity_error' };
			}
			if (viewedCommand.capability_hash === key.capabilityHash) {
				return { outcome: 'integrity_error' };
			}
			const lineageProven = await this.#verifyLineage(
				key.recipientId,
				viewedCommand.capability_hash,
				key.capabilityHash
			);
			if (!lineageProven) return { outcome: 'integrity_error' };
			return {
				outcome: 'continued',
				result: resultFromRow(viewedCommand)
			};
		}
		const auditHead: ViewedAuditHead | null = await this.#readAuditHead(key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return {
			outcome: 'ready',
			recipientRole: row.recipient_role,
			routingOrder: row.routing_order,
			sentCommitSha: row.envelope_sent_commit_sha as string,
			envelopeStatus: row.envelope_status as 'sent' | 'in_progress',
			auditHead
		};
	}

	async publishViewed(
		command: PublishRecipientViewedCommand
	): Promise<PublishRecipientViewedResult> {
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO recipient_viewed_command (
					envelope_id, recipient_id, recipient_role, routing_order,
					actor_type, actor_id, idempotency_key, request_hash, capability_hash,
					sent_commit_sha, updated_at, audit_event_id, audit_sequence,
					previous_audit_hash, audit_event_hash, audit_payload_json
				) VALUES (?, ?, ?, ?, ?, 'recipient', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.envelopeId,
				command.recipientId,
				command.recipientRole,
				command.routingOrder,
				command.recipientId,
				command.idempotencyKey,
				command.requestFingerprint,
				command.capabilityHash,
				command.expectedSentCommitSha,
				command.updatedAt,
				command.auditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventHash,
				command.auditPayloadJson
			);

		try {
			await this.#database.batch([statement]);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			const classified: PublishRecipientViewedResult | null = await this.#classifyFailure(command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async #readRecipientEnvelope(
		envelopeId: string,
		recipientId: string
	): Promise<RecipientEnvelopeRow | null> {
		return await this.#database
			.prepare(
				`SELECT recipient.role AS recipient_role, recipient.status AS recipient_status,
					recipient.capability_hash AS recipient_capability_hash,
					recipient.capability_expires_at AS recipient_capability_expires_at,
					recipient.capability_revoked_at AS recipient_capability_revoked_at,
					recipient.routing_order AS routing_order,
					envelope.status AS envelope_status,
					envelope.sent_commit_sha AS envelope_sent_commit_sha,
					envelope.repository_head AS envelope_repository_head
				 FROM recipient
				 INNER JOIN envelope
					ON envelope.id = recipient.envelope_id
				 WHERE recipient.envelope_id = ? AND recipient.id = ?
				 LIMIT 1`
			)
			.bind(envelopeId, recipientId)
			.first<RecipientEnvelopeRow>();
	}

	async #readAuditHead(envelopeId: string): Promise<ViewedAuditHead | null> {
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

	async #resolveCommand(key: ViewedCommandKey): Promise<ViewedPreparation | null> {
		const exact: ViewedCommandRow | null = await this.#readCommandRow(
			key.recipientId,
			key.idempotencyKey
		);
		if (exact !== null) {
			if (
				exact.envelope_id !== key.envelopeId ||
				exact.request_hash !== key.requestFingerprint ||
				exact.capability_hash !== key.capabilityHash
			) {
				return { outcome: 'idempotency_conflict' };
			}
			return await this.#evidenceResult(exact);
		}
		const byRecipient: ViewedCommandRow | null = await this.#readCommandRowByRecipient(
			key.recipientId
		);
		if (byRecipient === null) return null;
		if (byRecipient.envelope_id !== key.envelopeId) {
			return { outcome: 'integrity_error' };
		}
		if (byRecipient.capability_hash !== key.capabilityHash) {
			return null;
		}
		return await this.#evidenceResult(byRecipient);
	}

	async #verifyLineage(
		recipientId: string,
		initialHash: string,
		currentHash: string
	): Promise<boolean> {
		if (initialHash === currentHash) return true;
		const row = await this.#database
			.prepare(
				`WITH RECURSIVE lineage AS (
					SELECT capability_hash, predecessor_capability_hash
					FROM recipient_capability_issuance
					WHERE recipient_id = ?
						AND capability_hash = ?
					UNION ALL
					SELECT prev.capability_hash, prev.predecessor_capability_hash
					FROM recipient_capability_issuance prev
					INNER JOIN lineage curr ON curr.predecessor_capability_hash = prev.capability_hash
					WHERE prev.recipient_id = ?
				)
				SELECT count(*) AS count
				FROM lineage
				WHERE capability_hash = ?`
			)
			.bind(recipientId, currentHash, recipientId, initialHash)
			.first<{ count: number }>();
		return Number(row?.count ?? 0) > 0;
	}

	async #readCommandRow(
		recipientId: string,
		idempotencyKey: string
	): Promise<ViewedCommandRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${VIEWED_COMMAND_COLUMNS}
				 FROM recipient_viewed_command command
				 LEFT JOIN audit_event evidence
					ON evidence.id = command.audit_event_id
				 WHERE command.actor_type = 'recipient'
					AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(recipientId, idempotencyKey)
			.first<ViewedCommandRow>();
	}

	async #readCommandRowByRecipient(recipientId: string): Promise<ViewedCommandRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${VIEWED_COMMAND_COLUMNS}
				 FROM recipient_viewed_command command
				 LEFT JOIN audit_event evidence
					ON evidence.id = command.audit_event_id
				 WHERE command.recipient_id = ?
				 LIMIT 1`
			)
			.bind(recipientId)
			.first<ViewedCommandRow>();
	}

	async #evidenceResult(row: ViewedCommandRow): Promise<ViewedPreparation> {
		if (!validAuditEvidence(row) || !(await validStoredReceipt(row))) {
			return { outcome: 'integrity_error' };
		}
		return { outcome: 'replayed', result: resultFromRow(row) };
	}

	async #classifyFailure(
		command: PublishRecipientViewedCommand
	): Promise<PublishRecipientViewedResult | null> {
		const preparation: ViewedPreparation = await this.prepareViewed(command, command.updatedAt);
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
		return null;
	}
}

function authorized(row: RecipientEnvelopeRow, capabilityHash: string, at: string): boolean {
	return (
		(row.recipient_status === 'pending' || row.recipient_status === 'viewed') &&
		isPostSendInvitationRecipientRole(row.recipient_role) &&
		row.recipient_capability_hash === capabilityHash &&
		row.recipient_capability_revoked_at === null &&
		row.recipient_capability_expires_at !== null &&
		new Date(row.recipient_capability_expires_at).getTime() > new Date(at).getTime() &&
		(row.envelope_status === 'sent' || row.envelope_status === 'in_progress') &&
		row.envelope_sent_commit_sha !== null &&
		row.envelope_sent_commit_sha === row.envelope_repository_head
	);
}

function validAuditEvidence(row: ViewedCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'recipient.viewed' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at
	);
}

async function validStoredReceipt(row: ViewedCommandRow): Promise<boolean> {
	const requestHash: string = await sha256(
		JSON.stringify({
			envelopeId: row.envelope_id,
			recipientId: row.recipient_id,
			capabilityHash: row.capability_hash
		})
	);
	const auditPayload: string = JSON.stringify({
		recipientId: row.recipient_id,
		role: row.recipient_role,
		routingOrder: row.routing_order,
		sentCommitSha: row.sent_commit_sha,
		viewedAt: row.updated_at
	});
	return requestHash === row.request_hash && auditPayload === row.audit_payload_json;
}

function resultFromCommand(command: PublishRecipientViewedCommand): PublishedRecipientViewed {
	return {
		envelopeId: command.envelopeId,
		recipientId: command.recipientId,
		recipientRole: command.recipientRole,
		routingOrder: command.routingOrder,
		sentCommitSha: command.expectedSentCommitSha,
		envelopeStatus: 'in_progress',
		viewedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}

function resultFromRow(row: ViewedCommandRow): PublishedRecipientViewed {
	return {
		envelopeId: row.envelope_id,
		recipientId: row.recipient_id,
		recipientRole: row.recipient_role,
		routingOrder: row.routing_order,
		sentCommitSha: row.sent_commit_sha,
		envelopeStatus: 'in_progress',
		viewedAt: row.updated_at,
		auditEventId: row.audit_event_id
	};
}

function publishFromPreparation(preparation: ViewedPreparation): PublishRecipientViewedResult {
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
