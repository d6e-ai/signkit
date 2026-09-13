import postgres from 'postgres';
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

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class ViewedPublicationIntegrityError extends Error {
	constructor() {
		super('Recipient viewed publication integrity check failed');
		this.name = 'ViewedPublicationIntegrityError';
	}
}

interface RecipientEnvelopeRow {
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

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface ViewedCommandRow {
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
	updatedAt: Date | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
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
}

export class PostgresRecipientViewStore implements RecipientViewStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async prepareViewed(key: ViewedCommandKey, at: string): Promise<ViewedPreparation> {
		const row: RecipientEnvelopeRow | null = await this.#readRecipientEnvelope(
			this.#sql,
			key.organizationId,
			key.envelopeId,
			key.recipientId,
			false
		);
		if (row === null || !authorized(row, key.capabilityHash, at)) return { outcome: 'not_found' };
		const replay: ViewedPreparation | null = await this.#resolveCommand(this.#sql, key);
		if (replay !== null) {
			if (replay.outcome !== 'replayed') return replay;
			const current: RecipientEnvelopeRow | null = await this.#readRecipientEnvelope(
				this.#sql,
				key.organizationId,
				key.envelopeId,
				key.recipientId,
				false
			);
			if (current === null || !authorized(current, key.capabilityHash, at)) {
				return { outcome: 'not_found' };
			}
			if (current.recipientStatus !== 'viewed' || current.envelopeStatus !== 'in_progress') {
				return { outcome: 'integrity_error' };
			}
			return replay;
		}
		if (row.recipientStatus === 'viewed') {
			const viewedCommand: ViewedCommandRow | null = await this.#readCommandRowByRecipient(
				this.#sql,
				key.organizationId,
				key.recipientId
			);
			if (
				viewedCommand === null ||
				!validAuditEvidence(viewedCommand) ||
				!(await validStoredReceipt(viewedCommand))
			) {
				return { outcome: 'integrity_error' };
			}
			if (viewedCommand.capabilityHash === key.capabilityHash) {
				return { outcome: 'integrity_error' };
			}
			const lineageProven = await this.#verifyLineage(
				this.#sql,
				key.organizationId,
				key.recipientId,
				viewedCommand.capabilityHash,
				key.capabilityHash
			);
			if (!lineageProven) return { outcome: 'integrity_error' };
			return {
				outcome: 'continued',
				result: resultFromRow(viewedCommand)
			};
		}
		const auditHead: ViewedAuditHead | null = await this.#readAuditHead(
			this.#sql,
			key.organizationId,
			key.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return {
			outcome: 'ready',
			recipientRole: row.recipientRole,
			routingOrder: row.routingOrder,
			sentCommitSha: row.envelopeSentCommitSha as string,
			envelopeStatus: row.envelopeStatus as 'sent' | 'in_progress',
			auditHead
		};
	}

	async publishViewed(
		command: PublishRecipientViewedCommand
	): Promise<PublishRecipientViewedResult> {
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishRecipientViewedResult> => {
				const envelopeRows = await transaction<
					{ status: string; sentCommitSha: string | null; repositoryHead: string | null }[]
				>`
						SELECT status, sent_commit_sha AS "sentCommitSha", repository_head AS "repositoryHead"
						FROM envelope
						WHERE organization_id = ${command.organizationId} AND id = ${command.envelopeId}
						FOR UPDATE`;
				if (envelopeRows.length === 0) return { outcome: 'not_found' };

				const envelope = envelopeRows[0];
				if (
					!(envelope.status === 'sent' || envelope.status === 'in_progress') ||
					envelope.sentCommitSha === null ||
					envelope.sentCommitSha !== command.expectedSentCommitSha ||
					envelope.sentCommitSha !== envelope.repositoryHead
				) {
					return { outcome: 'not_found' };
				}

				const recipientRow: RecipientEnvelopeRow | null = await this.#readRecipientEnvelope(
					transaction,
					command.organizationId,
					command.envelopeId,
					command.recipientId,
					true
				);
				if (
					recipientRow === null ||
					!authorized(recipientRow, command.capabilityHash, command.updatedAt)
				) {
					return { outcome: 'not_found' };
				}
				const raced: ViewedPreparation | null = await this.#resolveCommand(transaction, command);
				if (raced !== null) {
					if (
						raced.outcome === 'replayed' &&
						(recipientRow.recipientStatus !== 'viewed' ||
							recipientRow.envelopeStatus !== 'in_progress')
					) {
						return { outcome: 'integrity_error' };
					}
					return publishFromPreparation(raced);
				}
				if (recipientRow.recipientStatus === 'viewed') {
					const viewedCommand: ViewedCommandRow | null = await this.#readCommandRowByRecipient(
						transaction,
						command.organizationId,
						command.recipientId
					);
					if (
						viewedCommand === null ||
						!validAuditEvidence(viewedCommand) ||
						!(await validStoredReceipt(viewedCommand))
					) {
						return { outcome: 'integrity_error' };
					}
					if (viewedCommand.capabilityHash === command.capabilityHash) {
						return { outcome: 'integrity_error' };
					}
					const lineageProven = await this.#verifyLineage(
						transaction,
						command.organizationId,
						command.recipientId,
						viewedCommand.capabilityHash,
						command.capabilityHash
					);
					if (!lineageProven) return { outcome: 'integrity_error' };
					return {
						outcome: 'continued',
						result: resultFromRow(viewedCommand)
					};
				}
				if (
					recipientRow.recipientRole !== command.recipientRole ||
					recipientRow.routingOrder !== command.routingOrder
				) {
					return { outcome: 'integrity_error' };
				}

				const auditHead: ViewedAuditHead | null = await this.#readAuditHead(
					transaction,
					command.organizationId,
					command.envelopeId
				);
				if (auditHead === null) return { outcome: 'integrity_error' };
				if (
					auditHead.sequence !== command.expectedAuditSequence ||
					auditHead.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'audit_conflict' };
				}

				const viewedRows = await transaction<{ id: string }[]>`
						UPDATE recipient SET status = 'viewed', updated_at = ${command.updatedAt}
						WHERE organization_id = ${command.organizationId} AND envelope_id = ${command.envelopeId}
							AND id = ${command.recipientId} AND status = 'pending'
							AND role IN ('signer', 'approver', 'viewer')
							AND role = ${command.recipientRole} AND routing_order = ${command.routingOrder}
							AND capability_hash = ${command.capabilityHash} AND capability_revoked_at IS NULL
							AND capability_expires_at IS NOT NULL AND capability_expires_at > ${command.updatedAt}::timestamptz
						RETURNING id`;
				if (viewedRows.length !== 1) throw new ViewedPublicationIntegrityError();

				const envelopeUpdateRows = await transaction<{ id: string }[]>`
						UPDATE envelope
						SET status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END,
							updated_at = ${command.updatedAt}
						WHERE organization_id = ${command.organizationId} AND id = ${command.envelopeId}
							AND status IN ('sent', 'in_progress')
							AND sent_commit_sha = ${command.expectedSentCommitSha}
							AND sent_commit_sha = repository_head
						RETURNING id`;
				if (envelopeUpdateRows.length !== 1) throw new ViewedPublicationIntegrityError();

				await transaction`INSERT INTO recipient_viewed_command (
						organization_id, envelope_id, recipient_id, recipient_role, routing_order,
						actor_type, actor_id, idempotency_key, request_hash, capability_hash,
						sent_commit_sha, updated_at, audit_event_id, audit_sequence,
						previous_audit_hash, audit_event_hash, audit_payload_json
					) VALUES (${command.organizationId}, ${command.envelopeId}, ${command.recipientId},
						${command.recipientRole}, ${command.routingOrder}, 'recipient', ${command.recipientId},
						${command.idempotencyKey}, ${command.requestFingerprint}, ${command.capabilityHash},
						${command.expectedSentCommitSha}, ${command.updatedAt}, ${command.auditEventId},
						${command.expectedAuditSequence + 1}, ${command.previousAuditHash}, ${command.auditEventHash},
						${command.auditPayloadJson})`;

				await transaction`INSERT INTO audit_event (
						id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at
					) VALUES (${command.auditEventId}, ${command.organizationId}, ${command.envelopeId},
						${command.expectedAuditSequence + 1}, 'recipient.viewed', 'recipient', ${command.recipientId},
						${command.auditPayloadJson}, ${command.previousAuditHash}, ${command.auditEventHash},
						${command.updatedAt})`;

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: PublishRecipientViewedResult | null = await this.#classifyFailure(command);
			if (classified !== null) return classified;
			if (error instanceof ViewedPublicationIntegrityError) return { outcome: 'integrity_error' };
			throw error;
		}
	}

	async #readRecipientEnvelope(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		recipientId: string,
		lock: boolean
	): Promise<RecipientEnvelopeRow | null> {
		const rows = lock
			? await sql<RecipientEnvelopeRow[]>`
				SELECT recipient.role AS "recipientRole", recipient.status AS "recipientStatus",
					recipient.capability_hash AS "recipientCapabilityHash",
					recipient.capability_expires_at AS "recipientCapabilityExpiresAt",
					recipient.capability_revoked_at AS "recipientCapabilityRevokedAt",
					recipient.routing_order AS "routingOrder",
					envelope.status AS "envelopeStatus",
					envelope.sent_commit_sha AS "envelopeSentCommitSha",
					envelope.repository_head AS "envelopeRepositoryHead"
				FROM recipient
				INNER JOIN envelope
					ON envelope.organization_id = recipient.organization_id
					AND envelope.id = recipient.envelope_id
				WHERE recipient.organization_id = ${organizationId} AND recipient.envelope_id = ${envelopeId}
					AND recipient.id = ${recipientId}
				FOR UPDATE OF recipient
				LIMIT 1`
			: await sql<RecipientEnvelopeRow[]>`
				SELECT recipient.role AS "recipientRole", recipient.status AS "recipientStatus",
					recipient.capability_hash AS "recipientCapabilityHash",
					recipient.capability_expires_at AS "recipientCapabilityExpiresAt",
					recipient.capability_revoked_at AS "recipientCapabilityRevokedAt",
					recipient.routing_order AS "routingOrder",
					envelope.status AS "envelopeStatus",
					envelope.sent_commit_sha AS "envelopeSentCommitSha",
					envelope.repository_head AS "envelopeRepositoryHead"
				FROM recipient
				INNER JOIN envelope
					ON envelope.organization_id = recipient.organization_id
					AND envelope.id = recipient.envelope_id
				WHERE recipient.organization_id = ${organizationId} AND recipient.envelope_id = ${envelopeId}
					AND recipient.id = ${recipientId}
				LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readAuditHead(
		sql: Sql,
		organizationId: string,
		envelopeId: string
	): Promise<ViewedAuditHead | null> {
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

	async #resolveCommand(sql: Sql, key: ViewedCommandKey): Promise<ViewedPreparation | null> {
		const exact: ViewedCommandRow | null = await this.#readCommandRow(
			sql,
			key.organizationId,
			key.recipientId,
			key.idempotencyKey
		);
		if (exact !== null) {
			if (
				exact.envelopeId !== key.envelopeId ||
				exact.requestHash !== key.requestFingerprint ||
				exact.capabilityHash !== key.capabilityHash
			) {
				return { outcome: 'idempotency_conflict' };
			}
			return await this.#evidenceResult(exact);
		}
		const byRecipient: ViewedCommandRow | null = await this.#readCommandRowByRecipient(
			sql,
			key.organizationId,
			key.recipientId
		);
		if (byRecipient === null) return null;
		if (byRecipient.envelopeId !== key.envelopeId) {
			return { outcome: 'integrity_error' };
		}
		if (byRecipient.capabilityHash !== key.capabilityHash) {
			return null;
		}
		return await this.#evidenceResult(byRecipient);
	}

	async #verifyLineage(
		sql: Sql,
		organizationId: string,
		recipientId: string,
		initialHash: string,
		currentHash: string
	): Promise<boolean> {
		if (initialHash === currentHash) return true;
		const rows = await sql<{ count: string | number }[]>`
			WITH RECURSIVE lineage AS (
				SELECT capability_hash, predecessor_capability_hash
				FROM recipient_capability_issuance
				WHERE organization_id = ${organizationId}
					AND recipient_id = ${recipientId}
					AND capability_hash = ${currentHash}
				UNION ALL
				SELECT prev.capability_hash, prev.predecessor_capability_hash
				FROM recipient_capability_issuance prev
				INNER JOIN lineage curr ON curr.predecessor_capability_hash = prev.capability_hash
				WHERE prev.organization_id = ${organizationId}
					AND prev.recipient_id = ${recipientId}
			)
			SELECT count(*) AS count
			FROM lineage
			WHERE capability_hash = ${initialHash}`;
		return Number(rows[0]?.count ?? 0) > 0;
	}

	async #readCommandRow(
		sql: Sql,
		organizationId: string,
		recipientId: string,
		idempotencyKey: string
	): Promise<ViewedCommandRow | null> {
		const rows = await sql<ViewedCommandRow[]>`
			SELECT command.organization_id AS "organizationId", command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha", command.updated_at AS "updatedAt",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash", command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson", evidence.id AS "evidenceEventId",
				evidence.organization_id AS "evidenceOrganizationId", evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt"
			FROM recipient_viewed_command command
			LEFT JOIN audit_event evidence
				ON evidence.organization_id = command.organization_id AND evidence.id = command.audit_event_id
			WHERE command.organization_id = ${organizationId} AND command.actor_type = 'recipient'
				AND command.actor_id = ${recipientId} AND command.idempotency_key = ${idempotencyKey}
			LIMIT 1`;
		return rows[0] ?? null;
	}

	async #readCommandRowByRecipient(
		sql: Sql,
		organizationId: string,
		recipientId: string
	): Promise<ViewedCommandRow | null> {
		const rows = await sql<ViewedCommandRow[]>`
			SELECT command.organization_id AS "organizationId", command.envelope_id AS "envelopeId",
				command.recipient_id AS "recipientId", command.recipient_role AS "recipientRole",
				command.routing_order AS "routingOrder", command.actor_type AS "actorType",
				command.actor_id AS "actorId", command.idempotency_key AS "idempotencyKey",
				command.request_hash AS "requestHash", command.capability_hash AS "capabilityHash",
				command.sent_commit_sha AS "sentCommitSha", command.updated_at AS "updatedAt",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash", command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson", evidence.id AS "evidenceEventId",
				evidence.organization_id AS "evidenceOrganizationId", evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt"
			FROM recipient_viewed_command command
			LEFT JOIN audit_event evidence
				ON evidence.organization_id = command.organization_id AND evidence.id = command.audit_event_id
			WHERE command.organization_id = ${organizationId} AND command.recipient_id = ${recipientId}
			LIMIT 1`;
		return rows[0] ?? null;
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
		(row.recipientStatus === 'pending' || row.recipientStatus === 'viewed') &&
		isPostSendInvitationRecipientRole(row.recipientRole) &&
		row.recipientCapabilityHash === capabilityHash &&
		row.recipientCapabilityRevokedAt === null &&
		row.recipientCapabilityExpiresAt !== null &&
		new Date(row.recipientCapabilityExpiresAt).getTime() > new Date(at).getTime() &&
		(row.envelopeStatus === 'sent' || row.envelopeStatus === 'in_progress') &&
		row.envelopeSentCommitSha !== null &&
		row.envelopeSentCommitSha === row.envelopeRepositoryHead
	);
}

function validAuditEvidence(row: ViewedCommandRow): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceOrganizationId === row.organizationId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'recipient.viewed' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt)
	);
}

async function validStoredReceipt(row: ViewedCommandRow): Promise<boolean> {
	const requestHash: string = await sha256(
		JSON.stringify({
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			capabilityHash: row.capabilityHash
		})
	);
	const auditPayload: string = JSON.stringify({
		recipientId: row.recipientId,
		role: row.recipientRole,
		routingOrder: row.routingOrder,
		sentCommitSha: row.sentCommitSha,
		viewedAt: isoTimestamp(row.updatedAt)
	});
	return requestHash === row.requestHash && auditPayload === row.auditPayloadJson;
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
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		recipientRole: row.recipientRole,
		routingOrder: row.routingOrder,
		sentCommitSha: row.sentCommitSha,
		envelopeStatus: 'in_progress',
		viewedAt: isoTimestamp(row.updatedAt),
		auditEventId: row.auditEventId
	};
}

function publishFromPreparation(preparation: ViewedPreparation): PublishRecipientViewedResult {
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
