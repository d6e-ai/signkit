import postgres from 'postgres';
import { sentAuditDocuments } from '$lib/application/documents/sent-document-pdf';
import {
	isActionableRecipientRole,
	isPostSendInvitationRecipientRole,
	type Envelope,
	type Recipient,
	type RecipientRole,
	type RecipientStatus
} from '$lib/domain/envelope';
import type {
	DeliveryManifestEntry,
	EnvelopeSendStore,
	PublishSentEnvelopeCommand,
	PublishSentEnvelopeResult,
	PublishedSentEnvelope,
	SendAuditHead,
	SendCommandKey,
	SendPreparation
} from '$lib/ports/envelope-send-store';
import { PostgresEnvelopeStore } from './postgres-envelope-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class SendPublicationIntegrityError extends Error {
	constructor() {
		super('Send publication integrity check failed');
		this.name = 'SendPublicationIntegrityError';
	}
}

interface RecipientRow {
	id: string;
	envelopeId: string;
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
	status: RecipientStatus;
	capabilityHash: string | null;
	capabilityExpiresAt: Date | string | null;
	capabilityRevokedAt: Date | string | null;
}
interface AuditHeadRow {
	id: string;
	sequence: number | string;
	eventHash: string;
	eventType: string;
}
interface ReadyAuditAnchorRow {
	sequence: number | string;
}
interface SendCommandRow {
	envelopeId: string;
	actorType: string;
	actorId: string;
	requestHash: string;
	expectedGeneration: number;
	readyAuditEventId: string;
	commitSha: string;
	initialRoutingOrder: number;
	deliveryCount: number;
	queuedDeliveryCount: number;
	deliveryManifestHash: string;
	deliveryManifestJson: string;
	initialCapabilityExpiresAt: Date | string;
	updatedAt: Date | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
	sentPdfObjectKey: string | null;
	sentPdfSha256: string | null;
	sentPdfBytes: number | string | null;
	sentPdfPageCount: number | string | null;
	sentPdfPageWidth: number | string | null;
	sentPdfPageHeight: number | string | null;
	sentPdfDocumentPagesJson: string | null;
	documentSetHash: string | null;
	documentCount: number | string | null;
	sentDocumentsJson: string | null;
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
}

interface DeliveryEvidenceRow {
	id: string;
	recipientId: string;
	status: string;
	retryable: boolean;
	capabilityHash: string;
	reservedCapabilityExpiresAt: Date | string | null;
	sealedCapability: string | null;
	sealingKeyId: string;
	sealedCapabilitySha256: string;
	recipientCapabilityHash: string | null;
	recipientCapabilityExpiresAt: Date | string | null;
}

export class PostgresEnvelopeSendStore implements EnvelopeSendStore {
	readonly #sql: ReturnType<typeof postgres>;
	readonly #envelopes: PostgresEnvelopeStore;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
		this.#envelopes = new PostgresEnvelopeStore(sql);
	}

	async prepareSend(
		key: SendCommandKey,
		expectedGeneration: number,
		expectedReadyAuditEventId: string
	): Promise<SendPreparation> {
		const replay: SendPreparation | null = await this.#resolveCommand(this.#sql, key);
		if (replay !== null) return replay;
		const envelope: Envelope | null = await this.#envelopes.findEnvelope(key.envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'ready') return { outcome: 'not_ready' };
		if (envelope.repositoryGeneration !== expectedGeneration)
			return { outcome: 'generation_conflict' };
		if (envelope.repositoryHead === null || envelope.sentCommitSha !== null)
			return { outcome: 'integrity_error' };
		const auditHead: SendAuditHead | null = await this.#readAuditHead(this.#sql, key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const readyAuditSequence: number | null = await this.#readReadyAuditSequence(
			this.#sql,
			key.envelopeId,
			expectedGeneration,
			envelope.repositoryHead,
			expectedReadyAuditEventId
		);
		if (readyAuditSequence === null || readyAuditSequence > auditHead.sequence)
			return { outcome: 'audit_conflict' };
		const recipients: readonly Recipient[] | null = await this.#readRecipients(
			this.#sql,
			key.envelopeId,
			false
		);
		if (recipients === null) return { outcome: 'integrity_error' };
		return { outcome: 'ready', envelope, recipients, auditHead };
	}

	async publishSend(command: PublishSentEnvelopeCommand): Promise<PublishSentEnvelopeResult> {
		const replay: SendPreparation | null = await this.#resolveCommand(this.#sql, command);
		if (replay !== null) return publishFromPreparation(replay);
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishSentEnvelopeResult> => {
				const envelopeRows = await transaction<
					{
						status: string;
						repositoryGeneration: number;
						repositoryHead: string | null;
						sentCommitSha: string | null;
					}[]
				>`
					SELECT status, repository_generation AS "repositoryGeneration", repository_head AS "repositoryHead",
						sent_commit_sha AS "sentCommitSha" FROM envelope
					WHERE id = ${command.envelopeId} FOR UPDATE`;
				if (envelopeRows.length === 0) return { outcome: 'not_found' };
				const raced: SendPreparation | null = await this.#resolveCommand(transaction, command);
				if (raced !== null) return publishFromPreparation(raced);
				const envelope = envelopeRows[0];
				if (envelope.status !== 'ready') return { outcome: 'not_ready' };
				if (envelope.repositoryGeneration !== command.expectedGeneration)
					return { outcome: 'generation_conflict' };
				if (envelope.repositoryHead !== command.commitSha || envelope.sentCommitSha !== null)
					return { outcome: 'integrity_error' };
				const auditHead: SendAuditHead | null = await this.#readAuditHead(
					transaction,
					command.envelopeId
				);
				if (auditHead === null) return { outcome: 'integrity_error' };
				const readyAuditSequence: number | null = await this.#readReadyAuditSequence(
					transaction,
					command.envelopeId,
					command.expectedGeneration,
					command.commitSha,
					command.expectedReadyAuditEventId
				);
				if (
					readyAuditSequence === null ||
					readyAuditSequence > auditHead.sequence ||
					auditHead.sequence !== command.expectedAuditSequence ||
					auditHead.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'audit_conflict' };
				}
				const recipients: readonly Recipient[] | null = await this.#readRecipients(
					transaction,
					command.envelopeId,
					true
				);
				if (recipients === null) return { outcome: 'integrity_error' };
				const expectedIds: Set<string> = new Set(
					recipients
						.filter((recipient: Recipient): boolean =>
							isPostSendInvitationRecipientRole(recipient.role)
						)
						.map((recipient: Recipient): string => recipient.id)
				);
				if (
					expectedIds.size !== command.deliveries.length ||
					command.deliveries.some((delivery): boolean => !expectedIds.has(delivery.recipientId))
				) {
					return { outcome: 'integrity_error' };
				}
				const recipientsById: Map<string, Recipient> = new Map(
					recipients.map((recipient: Recipient): [string, Recipient] => [recipient.id, recipient])
				);
				const minimumRoutingOrder: number = Math.min(
					...recipients
						.filter((recipient: Recipient): boolean => isActionableRecipientRole(recipient.role))
						.map((recipient: Recipient): number => recipient.routingOrder)
				);
				if (
					minimumRoutingOrder !== command.initialRoutingOrder ||
					command.deliveries.some((delivery): boolean => {
						const recipient: Recipient | undefined = recipientsById.get(delivery.recipientId);
						if (recipient === undefined) return true;
						const initial: boolean = recipient.routingOrder === command.initialRoutingOrder;
						return initial
							? delivery.status !== 'pending' ||
									delivery.availableAt === null ||
									delivery.capabilityExpiresAt !== command.initialCapabilityExpiresAt
							: recipient.routingOrder < command.initialRoutingOrder ||
									delivery.status !== 'blocked' ||
									delivery.availableAt !== null ||
									delivery.capabilityExpiresAt !== null;
					})
				) {
					return { outcome: 'integrity_error' };
				}
				const queuedDeliveryCount: number = command.deliveries.filter(
					(delivery): boolean => delivery.status === 'pending'
				).length;
				await transaction`INSERT INTO envelope_send_command (
					envelope_id, actor_type, actor_id, idempotency_key, request_hash,
					expected_generation, ready_audit_event_id, commit_sha, initial_routing_order,
					delivery_count, queued_delivery_count, delivery_manifest_hash, delivery_manifest_json,
					initial_capability_expires_at, updated_at, audit_event_id, audit_sequence,
					previous_audit_hash, audit_event_hash, audit_payload_json,
					document_set_hash, document_count, sent_documents_json
				) VALUES (${command.envelopeId}, ${command.actorType}, ${command.actorId},
					${command.idempotencyKey}, ${command.requestFingerprint}, ${command.expectedGeneration},
					${command.expectedReadyAuditEventId}, ${command.commitSha}, ${command.initialRoutingOrder},
					${command.deliveries.length}, ${queuedDeliveryCount}, ${command.deliveryManifestHash},
					${command.deliveryManifestJson},
					${command.initialCapabilityExpiresAt}, ${command.updatedAt}, ${command.auditEventId},
					${command.expectedAuditSequence + 1}, ${command.previousAuditHash}, ${command.auditEventHash},
					${command.auditPayloadJson}, ${command.sentDocumentSet.documentSetHash},
					${command.sentDocumentSet.documentCount},
					${JSON.stringify(sentAuditDocuments(command.sentDocumentSet.documents))})`;
				for (const delivery of command.deliveries) {
					const updated = await transaction<{ id: string }[]>`UPDATE recipient SET
						capability_hash = ${delivery.capabilityHash}, capability_expires_at = ${delivery.capabilityExpiresAt},
						capability_revoked_at = NULL, updated_at = ${command.updatedAt}
						WHERE envelope_id = ${command.envelopeId}
							AND id = ${delivery.recipientId} AND status = 'pending'
							AND capability_hash IS NULL AND capability_expires_at IS NULL AND capability_revoked_at IS NULL
						RETURNING id`;
					if (updated.length !== 1) throw new SendPublicationIntegrityError();
					await transaction`INSERT INTO delivery_outbox (
						id, envelope_id, recipient_id, kind, status, capability_hash,
						reserved_capability_expires_at,
						sealed_capability, sealing_key_id, sealed_capability_sha256, available_at,
						attempts, created_at, updated_at
					) VALUES (${delivery.id}, ${command.envelopeId}, ${delivery.recipientId},
						'recipient_invitation', ${delivery.status}, ${delivery.capabilityHash}, ${delivery.capabilityExpiresAt}, ${delivery.sealedCapability},
						${delivery.sealingKeyId}, ${delivery.sealedCapabilitySha256}, ${delivery.availableAt}, 0,
						${command.updatedAt}, ${command.updatedAt})`;
				}
				const counts = await transaction<{ deliveryCount: number; queuedCount: number }[]>`
					SELECT COUNT(*)::int AS "deliveryCount",
						COUNT(*) FILTER (WHERE status = 'pending')::int AS "queuedCount"
					FROM delivery_outbox WHERE envelope_id = ${command.envelopeId}`;
				if (
					counts[0]?.deliveryCount !== command.deliveries.length ||
					counts[0]?.queuedCount !== queuedDeliveryCount
				)
					throw new SendPublicationIntegrityError();
				const sent = await transaction<{ id: string }[]>`UPDATE envelope SET status = 'sent',
					sent_commit_sha = ${command.commitSha}, updated_at = ${command.updatedAt}
					WHERE id = ${command.envelopeId}
						AND status = 'ready' AND repository_generation = ${command.expectedGeneration}
						AND repository_head = ${command.commitSha} AND sent_commit_sha IS NULL RETURNING id`;
				if (sent.length !== 1) throw new SendPublicationIntegrityError();
				await transaction`INSERT INTO audit_event (
					id, envelope_id, sequence, event_type, actor_type, actor_id,
					payload_json, previous_hash, event_hash, occurred_at
				) VALUES (${command.auditEventId}, ${command.envelopeId},
					${command.expectedAuditSequence + 1}, 'envelope.sent', ${command.actorType}, ${command.actorId},
					${command.auditPayloadJson}, ${command.previousAuditHash}, ${command.auditEventHash}, ${command.updatedAt})`;
				// Same transaction as the status flip and the audit event, which is
				// the PostgreSQL equivalent of D1's send-publish trigger body: a
				// rollback from any of the checks above takes the pointer with it,
				// so a sent envelope never references a rendering of another
				// revision.
				for (const document of command.sentDocumentSet.documents) {
					await transaction`INSERT INTO envelope_sent_document (
						envelope_id, commit_sha, document_id, position, kind, title,
						object_key, sha256, byte_size, page_count, page_width, page_height, created_at
					) VALUES (
						${command.envelopeId}, ${command.commitSha},
						${document.documentId}, ${document.position}, ${document.kind}, ${document.title},
						${document.objectKey}, ${document.sha256}, ${document.byteSize},
						${document.pageCount}, ${document.pageWidth}, ${document.pageHeight},
						${command.updatedAt}
					) ON CONFLICT (envelope_id, commit_sha, document_id) DO NOTHING`;
				}
				const sentDocumentCount = await transaction<{ count: number }[]>`
					SELECT COUNT(*)::int AS count FROM envelope_sent_document
					WHERE envelope_id = ${command.envelopeId}
						AND commit_sha = ${command.commitSha}`;
				if (sentDocumentCount[0]?.count !== command.sentDocumentSet.documentCount) {
					throw new SendPublicationIntegrityError();
				}
				await transaction`INSERT INTO envelope_sent_document_set (
					envelope_id, commit_sha, document_set_hash, document_count, created_at
				) VALUES (${command.envelopeId}, ${command.commitSha},
					${command.sentDocumentSet.documentSetHash}, ${command.sentDocumentSet.documentCount},
					${command.updatedAt})`;
				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: SendPreparation = await this.prepareSend(
				command,
				command.expectedGeneration,
				command.expectedReadyAuditEventId
			);
			if (classified.outcome !== 'ready') return publishFromPreparation(classified);
			if (error instanceof SendPublicationIntegrityError) return { outcome: 'integrity_error' };
			throw error;
		}
	}

	async #readRecipients(
		sql: Sql,
		envelopeId: string,
		lock: boolean
	): Promise<readonly Recipient[] | null> {
		const rows = lock
			? await sql<RecipientRow[]>`SELECT id, envelope_id AS "envelopeId",
				email, name, role, locale, routing_order AS "routingOrder", status,
				capability_hash AS "capabilityHash", capability_expires_at AS "capabilityExpiresAt",
				capability_revoked_at AS "capabilityRevokedAt" FROM recipient
				WHERE envelope_id = ${envelopeId} ORDER BY routing_order, id FOR UPDATE`
			: await sql<RecipientRow[]>`SELECT id, envelope_id AS "envelopeId",
				email, name, role, locale, routing_order AS "routingOrder", status,
				capability_hash AS "capabilityHash", capability_expires_at AS "capabilityExpiresAt",
				capability_revoked_at AS "capabilityRevokedAt" FROM recipient
				WHERE envelope_id = ${envelopeId} ORDER BY routing_order, id`;
		if (
			rows.length < 1 ||
			rows.length > 50 ||
			rows.some(
				(row: RecipientRow): boolean =>
					row.status !== 'pending' ||
					row.capabilityHash !== null ||
					row.capabilityExpiresAt !== null ||
					row.capabilityRevokedAt !== null
			)
		)
			return null;
		return rows.map((row: RecipientRow): Recipient => ({
			id: row.id,
			envelopeId: row.envelopeId,
			email: row.email,
			name: row.name,
			role: row.role,
			locale: row.locale,
			routingOrder: row.routingOrder,
			status: row.status
		}));
	}

	async #readReadyAuditSequence(
		sql: Sql,
		envelopeId: string,
		expectedGeneration: number,
		expectedCommitSha: string,
		expectedReadyAuditEventId: string
	): Promise<number | null> {
		const rows = await sql<ReadyAuditAnchorRow[]>`
			SELECT ready.audit_sequence AS sequence
			FROM envelope_ready_command ready
			JOIN audit_event evidence
				ON evidence.envelope_id = ready.envelope_id
				AND evidence.id = ready.audit_event_id
				AND evidence.sequence = ready.audit_sequence
				AND evidence.event_type = 'envelope.ready'
			WHERE ready.envelope_id = ${envelopeId}
				AND ready.expected_generation = ${expectedGeneration}
				AND ready.commit_sha = ${expectedCommitSha}
				AND ready.audit_event_id = ${expectedReadyAuditEventId}
			LIMIT 1
		`;
		const row: ReadyAuditAnchorRow | undefined = rows[0];
		if (row === undefined) return null;
		const sequence: number = typeof row.sequence === 'number' ? row.sequence : Number(row.sequence);
		return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
	}

	async #readAuditHead(sql: Sql, envelopeId: string): Promise<SendAuditHead | null> {
		const rows = await sql<
			AuditHeadRow[]
		>`SELECT id, sequence, event_hash AS "eventHash", event_type AS "eventType" FROM audit_event
			WHERE envelope_id = ${envelopeId} ORDER BY sequence DESC LIMIT 1`;
		const row: AuditHeadRow | undefined = rows[0];
		if (
			row === undefined ||
			!Number.isSafeInteger(Number(row.sequence)) ||
			Number(row.sequence) < 1 ||
			row.eventHash.length === 0
		)
			return null;
		return {
			eventId: row.id,
			eventType: row.eventType,
			sequence: Number(row.sequence),
			eventHash: row.eventHash
		};
	}

	async #resolveCommand(sql: Sql, key: SendCommandKey): Promise<SendPreparation | null> {
		const rows = await sql<SendCommandRow[]>`SELECT
			command.envelope_id AS "envelopeId", command.actor_type AS "actorType", command.actor_id AS "actorId",
			command.request_hash AS "requestHash", command.expected_generation AS "expectedGeneration",
			command.ready_audit_event_id AS "readyAuditEventId", command.commit_sha AS "commitSha",
			command.initial_routing_order AS "initialRoutingOrder", command.delivery_count AS "deliveryCount",
			command.queued_delivery_count AS "queuedDeliveryCount", command.delivery_manifest_hash AS "deliveryManifestHash",
			command.delivery_manifest_json AS "deliveryManifestJson",
			command.initial_capability_expires_at AS "initialCapabilityExpiresAt", command.updated_at AS "updatedAt",
			command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
			command.previous_audit_hash AS "previousAuditHash", command.audit_event_hash AS "auditEventHash",
			command.audit_payload_json AS "auditPayloadJson",
			command.sent_pdf_object_key AS "sentPdfObjectKey", command.sent_pdf_sha256 AS "sentPdfSha256",
			command.sent_pdf_bytes AS "sentPdfBytes", command.sent_pdf_page_count AS "sentPdfPageCount",
			command.sent_pdf_page_width AS "sentPdfPageWidth", command.sent_pdf_page_height AS "sentPdfPageHeight",
			command.sent_pdf_document_pages_json AS "sentPdfDocumentPagesJson",
			command.document_set_hash AS "documentSetHash", command.document_count AS "documentCount",
			command.sent_documents_json AS "sentDocumentsJson",
			evidence.id AS "evidenceEventId",
			evidence.envelope_id AS "evidenceEnvelopeId",
			evidence.sequence AS "evidenceSequence", evidence.event_type AS "evidenceEventType",
			evidence.actor_type AS "evidenceActorType", evidence.actor_id AS "evidenceActorId",
			evidence.payload_json AS "evidencePayloadJson", evidence.previous_hash AS "evidencePreviousHash",
			evidence.event_hash AS "evidenceEventHash", evidence.occurred_at AS "evidenceOccurredAt"
			FROM envelope_send_command command LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			WHERE command.actor_type = ${key.actorType}
				AND command.actor_id = ${key.actorId} AND command.idempotency_key = ${key.idempotencyKey} LIMIT 1`;
		const row: SendCommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (row.envelopeId !== key.envelopeId || row.requestHash !== key.requestFingerprint)
			return { outcome: 'idempotency_conflict' };
		if (!validAuditEvidence(row) || !(await validStoredReceipt(row)))
			return { outcome: 'integrity_error' };
		const manifest: readonly DeliveryManifestEntry[] | null = parseDeliveryManifest(
			row.deliveryManifestJson
		);
		if (
			manifest === null ||
			manifest.length !== row.deliveryCount ||
			!(await this.#validDeliveryEvidence(sql, row, manifest))
		)
			return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}

	async #validDeliveryEvidence(
		sql: Sql,
		row: SendCommandRow,
		manifest: readonly DeliveryManifestEntry[]
	): Promise<boolean> {
		const evidence = await sql<DeliveryEvidenceRow[]>`SELECT delivery.id, delivery.status,
			delivery.retryable,
			delivery.recipient_id AS "recipientId", delivery.capability_hash AS "capabilityHash",
			delivery.reserved_capability_expires_at AS "reservedCapabilityExpiresAt",
			delivery.sealed_capability AS "sealedCapability",
			delivery.sealing_key_id AS "sealingKeyId",
			delivery.sealed_capability_sha256 AS "sealedCapabilitySha256",
			recipient.capability_hash AS "recipientCapabilityHash",
			recipient.capability_expires_at AS "recipientCapabilityExpiresAt"
			FROM delivery_outbox delivery JOIN recipient
				ON recipient.id = delivery.recipient_id
				AND recipient.envelope_id = delivery.envelope_id
			WHERE delivery.envelope_id = ${row.envelopeId}
			ORDER BY delivery.id`;
		if (evidence.length !== manifest.length) return false;
		for (let index: number = 0; index < manifest.length; index += 1) {
			const entry: DeliveryManifestEntry = manifest[index];
			const item: DeliveryEvidenceRow | undefined = evidence[index];
			if (!(
				item !== undefined &&
				item.id === entry.id &&
				item.recipientId === entry.recipientId &&
				item.capabilityHash === entry.capabilityHash &&
				item.recipientCapabilityHash === entry.capabilityHash &&
				nullableTimestamp(item.recipientCapabilityExpiresAt) ===
					nullableTimestamp(item.reservedCapabilityExpiresAt) &&
				item.sealingKeyId === entry.sealingKeyId &&
				item.sealedCapabilitySha256 === entry.sealedCapabilitySha256
			))
				return false;
			const reservedExpiry: string | null = nullableTimestamp(item.reservedCapabilityExpiresAt);
			if (
				(entry.initialStatus === 'pending' && reservedExpiry !== entry.capabilityExpiresAt) ||
				(entry.initialStatus === 'blocked' &&
					((item.status === 'blocked' && reservedExpiry !== null) ||
						(item.status !== 'blocked' &&
							reservedExpiry === null &&
							!(item.status === 'failed' && !item.retryable))))
			)
				return false;
			const scrubbedTerminal: boolean =
				(item.status === 'delivered' || item.status === 'failed') && !item.retryable;
			if (item.sealedCapability === null) {
				if (!scrubbedTerminal) return false;
			} else if (
				scrubbedTerminal ||
				(await sha256(item.sealedCapability)) !== entry.sealedCapabilitySha256
			) {
				return false;
			}
		}
		return true;
	}
}

function validAuditEvidence(row: SendCommandRow): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'envelope.sent' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt)
	);
}

async function validStoredReceipt(row: SendCommandRow): Promise<boolean> {
	const requestHash: string = await sha256(
		JSON.stringify({
			expectedGeneration: row.expectedGeneration,
			expectedReadyAuditEventId: row.readyAuditEventId
		})
	);
	if (
		requestHash !== row.requestHash ||
		(await sha256(row.deliveryManifestJson)) !== row.deliveryManifestHash
	) {
		return false;
	}
	if (isDocumentSetReceipt(row)) {
		const documents = parseSentAuditDocuments(row.sentDocumentsJson);
		const documentCount: number = Number(row.documentCount);
		if (documents === null || documents.length !== documentCount) return false;
		return (
			JSON.stringify({
				commitSha: row.commitSha,
				generation: row.expectedGeneration,
				readyAuditEventId: row.readyAuditEventId,
				initialRoutingOrder: row.initialRoutingOrder,
				queuedDeliveryCount: row.queuedDeliveryCount,
				reservedCapabilityCount: row.deliveryCount,
				deliveryManifestHash: row.deliveryManifestHash,
				initialCapabilityExpiresAt: isoTimestamp(row.initialCapabilityExpiresAt),
				documentSetHash: row.documentSetHash,
				documentCount,
				documents
			}) === row.auditPayloadJson
		);
	}
	if (isLegacySentPdfReceipt(row)) {
		return (
			JSON.stringify({
				commitSha: row.commitSha,
				generation: row.expectedGeneration,
				readyAuditEventId: row.readyAuditEventId,
				initialRoutingOrder: row.initialRoutingOrder,
				queuedDeliveryCount: row.queuedDeliveryCount,
				reservedCapabilityCount: row.deliveryCount,
				deliveryManifestHash: row.deliveryManifestHash,
				initialCapabilityExpiresAt: isoTimestamp(row.initialCapabilityExpiresAt),
				sentPdfSha256: row.sentPdfSha256,
				sentPdfBytes: row.sentPdfBytes === null ? null : Number(row.sentPdfBytes),
				sentPdfPageCount: row.sentPdfPageCount === null ? null : Number(row.sentPdfPageCount)
			}) === row.auditPayloadJson
		);
	}
	return false;
}

function isDocumentSetReceipt(row: SendCommandRow): row is SendCommandRow & {
	documentSetHash: string;
	documentCount: number | string;
	sentDocumentsJson: string;
} {
	return (
		row.documentSetHash !== null &&
		row.documentCount !== null &&
		row.sentDocumentsJson !== null &&
		row.sentPdfObjectKey === null &&
		row.sentPdfSha256 === null &&
		row.sentPdfBytes === null &&
		row.sentPdfPageCount === null &&
		row.sentPdfPageWidth === null &&
		row.sentPdfPageHeight === null &&
		row.sentPdfDocumentPagesJson === null
	);
}

function isLegacySentPdfReceipt(row: SendCommandRow): boolean {
	return (
		row.documentSetHash === null &&
		row.documentCount === null &&
		row.sentDocumentsJson === null &&
		row.sentPdfObjectKey !== null &&
		row.sentPdfSha256 !== null &&
		row.sentPdfBytes !== null &&
		row.sentPdfPageCount !== null &&
		row.sentPdfPageWidth !== null &&
		row.sentPdfPageHeight !== null &&
		row.sentPdfDocumentPagesJson !== null
	);
}

function parseSentAuditDocuments(
	value: string
): readonly { id: string; sha256: string; byteSize: number; pageCount: number }[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) return null;
	const documents: { id: string; sha256: string; byteSize: number; pageCount: number }[] = [];
	for (const candidate of parsed) {
		if (typeof candidate !== 'object' || candidate === null) return null;
		const entry = candidate as Record<string, unknown>;
		if (
			Object.keys(entry).length !== 4 ||
			typeof entry.id !== 'string' ||
			typeof entry.sha256 !== 'string' ||
			typeof entry.byteSize !== 'number' ||
			!Number.isInteger(entry.byteSize) ||
			typeof entry.pageCount !== 'number' ||
			!Number.isInteger(entry.pageCount)
		) {
			return null;
		}
		documents.push({
			id: entry.id,
			sha256: entry.sha256,
			byteSize: entry.byteSize,
			pageCount: entry.pageCount
		});
	}
	return documents;
}

function parseDeliveryManifest(value: string): readonly DeliveryManifestEntry[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const entries: DeliveryManifestEntry[] = [];
	for (const value of parsed) {
		if (typeof value !== 'object' || value === null) return null;
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.id !== 'string' ||
			typeof entry.recipientId !== 'string' ||
			typeof entry.capabilityHash !== 'string' ||
			!(entry.capabilityExpiresAt === null || typeof entry.capabilityExpiresAt === 'string') ||
			typeof entry.sealingKeyId !== 'string' ||
			typeof entry.sealedCapabilitySha256 !== 'string' ||
			!(entry.initialStatus === 'blocked' || entry.initialStatus === 'pending') ||
			!(entry.initialAvailableAt === null || typeof entry.initialAvailableAt === 'string')
		)
			return null;
		entries.push(entry as unknown as DeliveryManifestEntry);
	}
	return entries;
}

function nullableTimestamp(value: Date | string | null): string | null {
	return value === null ? null : isoTimestamp(value);
}

function resultFromCommand(command: PublishSentEnvelopeCommand): PublishedSentEnvelope {
	return {
		envelopeId: command.envelopeId,
		status: 'sent',
		generation: command.expectedGeneration,
		commitSha: command.commitSha,
		readyAuditEventId: command.expectedReadyAuditEventId,
		queuedDeliveryCount: command.deliveries.filter(
			(delivery): boolean => delivery.status === 'pending'
		).length,
		reservedCapabilityCount: command.deliveries.length,
		initialCapabilityExpiresAt: command.initialCapabilityExpiresAt,
		updatedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}
function resultFromRow(row: SendCommandRow): PublishedSentEnvelope {
	return {
		envelopeId: row.envelopeId,
		status: 'sent',
		generation: row.expectedGeneration,
		commitSha: row.commitSha,
		readyAuditEventId: row.readyAuditEventId,
		queuedDeliveryCount: row.queuedDeliveryCount,
		reservedCapabilityCount: row.deliveryCount,
		initialCapabilityExpiresAt: isoTimestamp(row.initialCapabilityExpiresAt),
		updatedAt: isoTimestamp(row.updatedAt),
		auditEventId: row.auditEventId
	};
}
function publishFromPreparation(preparation: SendPreparation): PublishSentEnvelopeResult {
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
