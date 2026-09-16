import { sentAuditDocuments } from '$lib/application/documents/sent-document-pdf';
import type { Envelope, Recipient, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
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
import { D1EnvelopeStore } from './d1-envelope-store';

interface RecipientRow {
	id: string;
	envelope_id: string;
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routing_order: number;
	status: RecipientStatus;
	capability_hash: string | null;
	capability_expires_at: string | null;
	capability_revoked_at: string | null;
}

interface AuditHeadRow {
	id: string;
	sequence: number;
	event_hash: string;
	event_type: string;
}

interface ReadyAuditAnchorRow {
	sequence: number;
}

interface SendCommandRow {
	envelope_id: string;
	actor_type: string;
	actor_id: string;
	request_hash: string;
	expected_generation: number;
	ready_audit_event_id: string;
	commit_sha: string;
	initial_routing_order: number;
	delivery_count: number;
	queued_delivery_count: number;
	delivery_manifest_hash: string;
	delivery_manifest_json: string;
	initial_capability_expires_at: string;
	updated_at: string;
	audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
	sent_pdf_object_key: string | null;
	sent_pdf_sha256: string | null;
	sent_pdf_bytes: number | null;
	sent_pdf_page_count: number | null;
	sent_pdf_page_width: number | null;
	sent_pdf_page_height: number | null;
	sent_pdf_document_pages_json: string | null;
	document_set_hash: string | null;
	document_count: number | null;
	sent_documents_json: string | null;
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

interface DeliveryEvidenceRow {
	id: string;
	recipient_id: string;
	status: string;
	retryable: number;
	capability_hash: string;
	reserved_capability_expires_at: string | null;
	sealed_capability: string | null;
	sealing_key_id: string;
	sealed_capability_sha256: string;
	recipient_capability_hash: string | null;
	recipient_capability_expires_at: string | null;
}

export class D1EnvelopeSendStore implements EnvelopeSendStore {
	readonly #database: D1Database;
	readonly #envelopes: D1EnvelopeStore;

	constructor(database: D1Database) {
		this.#database = database;
		this.#envelopes = new D1EnvelopeStore(database);
	}

	async prepareSend(
		key: SendCommandKey,
		expectedGeneration: number,
		expectedReadyAuditEventId: string
	): Promise<SendPreparation> {
		const replay: SendPreparation | null = await this.#resolveCommand(key);
		if (replay !== null) return replay;
		const envelope: Envelope | null = await this.#envelopes.findEnvelope(key.envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'ready') return { outcome: 'not_ready' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		if (envelope.repositoryHead === null || envelope.sentCommitSha !== null) {
			return { outcome: 'integrity_error' };
		}
		const auditHead: SendAuditHead | null = await this.#readAuditHead(key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const readyAuditSequence: number | null = await this.#readReadyAuditSequence(
			key.envelopeId,
			expectedGeneration,
			envelope.repositoryHead,
			expectedReadyAuditEventId
		);
		if (readyAuditSequence === null || readyAuditSequence > auditHead.sequence)
			return { outcome: 'audit_conflict' };
		const recipients: readonly Recipient[] | null = await this.#readRecipients(key.envelopeId);
		if (recipients === null) return { outcome: 'integrity_error' };
		return { outcome: 'ready', envelope, recipients, auditHead };
	}

	async publishSend(command: PublishSentEnvelopeCommand): Promise<PublishSentEnvelopeResult> {
		const replay: SendPreparation | null = await this.#resolveCommand(command);
		if (replay !== null) return publishFromPreparation(replay);
		const queuedDeliveryCount: number = command.deliveries.filter(
			(delivery): boolean => delivery.status === 'pending'
		).length;
		const statements: D1PreparedStatement[] = [
			this.#database
				.prepare(
					`INSERT INTO envelope_send_command (
					envelope_id, actor_type, actor_id, idempotency_key, request_hash,
					expected_generation, ready_audit_event_id, commit_sha, initial_routing_order,
					delivery_count, queued_delivery_count, delivery_manifest_hash, delivery_manifest_json,
					initial_capability_expires_at, updated_at, audit_event_id, audit_sequence,
					previous_audit_hash, audit_event_hash, audit_payload_json,
					document_set_hash, document_count, sent_documents_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					command.envelopeId,
					command.actorType,
					command.actorId,
					command.idempotencyKey,
					command.requestFingerprint,
					command.expectedGeneration,
					command.expectedReadyAuditEventId,
					command.commitSha,
					command.initialRoutingOrder,
					command.deliveries.length,
					queuedDeliveryCount,
					command.deliveryManifestHash,
					command.deliveryManifestJson,
					command.initialCapabilityExpiresAt,
					command.updatedAt,
					command.auditEventId,
					command.expectedAuditSequence + 1,
					command.previousAuditHash,
					command.auditEventHash,
					command.auditPayloadJson,
					command.sentDocumentSet.documentSetHash,
					command.sentDocumentSet.documentCount,
					JSON.stringify(sentAuditDocuments(command.sentDocumentSet.documents))
				),
			...command.deliveries.flatMap((delivery): D1PreparedStatement[] => [
				this.#database
					.prepare(
						`UPDATE recipient SET capability_hash = ?, capability_expires_at = ?,
						capability_revoked_at = NULL, updated_at = ?
					 WHERE envelope_id = ? AND id = ?
						AND status = 'pending' AND capability_hash IS NULL
						AND capability_expires_at IS NULL AND capability_revoked_at IS NULL`
					)
					.bind(
						delivery.capabilityHash,
						delivery.capabilityExpiresAt,
						command.updatedAt,
						command.envelopeId,
						delivery.recipientId
					),
				this.#database
					.prepare(
						`INSERT INTO delivery_outbox (
						id, envelope_id, recipient_id, kind, status,
						capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id,
						sealed_capability_sha256, available_at, attempts, created_at, updated_at
					) VALUES (?, ?, ?, 'recipient_invitation', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
					)
					.bind(
						delivery.id,
						command.envelopeId,
						delivery.recipientId,
						delivery.status,
						delivery.capabilityHash,
						delivery.capabilityExpiresAt,
						delivery.sealedCapability,
						delivery.sealingKeyId,
						delivery.sealedCapabilitySha256,
						delivery.availableAt,
						command.updatedAt,
						command.updatedAt
					)
			]),
			...command.sentDocumentSet.documents.map((document) =>
				this.#database
					.prepare(
						`INSERT INTO envelope_sent_document (
						envelope_id, commit_sha, document_id, position, kind, title,
						object_key, sha256, byte_size, page_count, page_width, page_height, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (envelope_id, commit_sha, document_id) DO NOTHING`
					)
					.bind(
						command.envelopeId,
						command.commitSha,
						document.documentId,
						document.position,
						document.kind,
						document.title,
						document.objectKey,
						document.sha256,
						document.byteSize,
						document.pageCount,
						document.pageWidth,
						document.pageHeight,
						command.updatedAt
					)
			),
			this.#database
				.prepare(
					`INSERT INTO envelope_send_publish (
					actor_type, actor_id, idempotency_key
				) VALUES (?, ?, ?)`
				)
				.bind(command.actorType, command.actorId, command.idempotencyKey)
		];
		try {
			await this.#database.batch(statements);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			const raced: SendPreparation | null = await this.#resolveCommand(command);
			if (raced !== null) return publishFromPreparation(raced);
			const classified: SendPreparation = await this.prepareSend(
				command,
				command.expectedGeneration,
				command.expectedReadyAuditEventId
			);
			if (classified.outcome !== 'ready') return publishFromPreparation(classified);
			if (
				classified.auditHead.sequence !== command.expectedAuditSequence ||
				classified.auditHead.eventHash !== command.previousAuditHash
			)
				return { outcome: 'audit_conflict' };
			throw error;
		}
	}

	async #readRecipients(envelopeId: string): Promise<readonly Recipient[] | null> {
		const result = await this.#database
			.prepare(
				`SELECT id, envelope_id, email, name, role, locale,
				routing_order, status, capability_hash, capability_expires_at, capability_revoked_at
			 FROM recipient WHERE envelope_id = ?
			 ORDER BY routing_order, id`
			)
			.bind(envelopeId)
			.all<RecipientRow>();
		const rows: RecipientRow[] = result.results;
		if (rows.length < 1 || rows.length > 50) return null;
		if (
			rows.some(
				(row: RecipientRow): boolean =>
					row.status !== 'pending' ||
					row.capability_hash !== null ||
					row.capability_expires_at !== null ||
					row.capability_revoked_at !== null
			)
		)
			return null;
		return rows.map(fromRecipientRow);
	}

	async #readAuditHead(envelopeId: string): Promise<SendAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT id, sequence, event_hash, event_type FROM audit_event
			 WHERE envelope_id = ? ORDER BY sequence DESC LIMIT 1`
			)
			.bind(envelopeId)
			.first<AuditHeadRow>();
		if (
			row === null ||
			!Number.isSafeInteger(row.sequence) ||
			row.sequence < 1 ||
			row.event_hash.length === 0
		)
			return null;
		return {
			eventId: row.id,
			eventType: row.event_type,
			sequence: row.sequence,
			eventHash: row.event_hash
		};
	}

	async #readReadyAuditSequence(
		envelopeId: string,
		expectedGeneration: number,
		expectedCommitSha: string,
		expectedReadyAuditEventId: string
	): Promise<number | null> {
		const row: ReadyAuditAnchorRow | null = await this.#database
			.prepare(
				`SELECT ready.audit_sequence AS sequence
				 FROM envelope_ready_command ready
				 JOIN audit_event evidence
					ON evidence.envelope_id = ready.envelope_id
					AND evidence.id = ready.audit_event_id
					AND evidence.sequence = ready.audit_sequence
					AND evidence.event_type = 'envelope.ready'
				 WHERE ready.envelope_id = ?
					AND ready.expected_generation = ? AND ready.commit_sha = ?
					AND ready.audit_event_id = ?
				 LIMIT 1`
			)
			.bind(envelopeId, expectedGeneration, expectedCommitSha, expectedReadyAuditEventId)
			.first<ReadyAuditAnchorRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		return row.sequence;
	}

	async #resolveCommand(key: SendCommandKey): Promise<SendPreparation | null> {
		const row: SendCommandRow | null = await this.#database
			.prepare(
				`SELECT command.*, evidence.id AS evidence_event_id,
				evidence.envelope_id AS evidence_envelope_id, evidence.sequence AS evidence_sequence,
				evidence.event_type AS evidence_event_type, evidence.actor_type AS evidence_actor_type,
				evidence.actor_id AS evidence_actor_id, evidence.payload_json AS evidence_payload_json,
				evidence.previous_hash AS evidence_previous_hash, evidence.event_hash AS evidence_event_hash,
				evidence.occurred_at AS evidence_occurred_at
			 FROM envelope_send_command command LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			 WHERE command.actor_type = ? AND command.actor_id = ?
				AND command.idempotency_key = ? LIMIT 1`
			)
			.bind(key.actorType, key.actorId, key.idempotencyKey)
			.first<SendCommandRow>();
		if (row === null) return null;
		if (row.envelope_id !== key.envelopeId || row.request_hash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!validAuditEvidence(row) || !(await validStoredReceipt(row)))
			return { outcome: 'integrity_error' };
		const manifest: readonly DeliveryManifestEntry[] | null = parseDeliveryManifest(
			row.delivery_manifest_json
		);
		if (
			manifest === null ||
			manifest.length !== row.delivery_count ||
			!(await this.#validDeliveryEvidence(row, manifest))
		)
			return { outcome: 'integrity_error' };
		return { outcome: 'replayed', result: resultFromRow(row) };
	}

	async #validDeliveryEvidence(
		row: SendCommandRow,
		manifest: readonly DeliveryManifestEntry[]
	): Promise<boolean> {
		const result = await this.#database
			.prepare(
				`SELECT delivery.id, delivery.recipient_id, delivery.status, delivery.retryable,
					delivery.capability_hash,
					delivery.reserved_capability_expires_at, delivery.sealing_key_id,
					delivery.sealed_capability, delivery.sealed_capability_sha256,
					recipient.capability_hash AS recipient_capability_hash,
					recipient.capability_expires_at AS recipient_capability_expires_at
				 FROM delivery_outbox delivery JOIN recipient
					ON recipient.id = delivery.recipient_id
					AND recipient.envelope_id = delivery.envelope_id
				 WHERE delivery.envelope_id = ?
				 ORDER BY delivery.id`
			)
			.bind(row.envelope_id)
			.all<DeliveryEvidenceRow>();
		if (result.results.length !== manifest.length) return false;
		for (let index: number = 0; index < manifest.length; index += 1) {
			const entry: DeliveryManifestEntry = manifest[index];
			const evidence: DeliveryEvidenceRow | undefined = result.results[index];
			if (!(
				evidence !== undefined &&
				evidence.id === entry.id &&
				evidence.recipient_id === entry.recipientId &&
				evidence.capability_hash === entry.capabilityHash &&
				evidence.recipient_capability_hash === entry.capabilityHash &&
				evidence.recipient_capability_expires_at === evidence.reserved_capability_expires_at &&
				evidence.sealing_key_id === entry.sealingKeyId &&
				evidence.sealed_capability_sha256 === entry.sealedCapabilitySha256
			))
				return false;
			const reservedExpiry: string | null = evidence.reserved_capability_expires_at;
			if (
				(entry.initialStatus === 'pending' && reservedExpiry !== entry.capabilityExpiresAt) ||
				(entry.initialStatus === 'blocked' &&
					((evidence.status === 'blocked' && reservedExpiry !== null) ||
						(evidence.status !== 'blocked' &&
							reservedExpiry === null &&
							!(evidence.status === 'failed' && evidence.retryable === 0))))
			)
				return false;
			const scrubbedTerminal: boolean =
				(evidence.status === 'delivered' || evidence.status === 'failed') &&
				evidence.retryable === 0;
			if (evidence.sealed_capability === null) {
				if (!scrubbedTerminal) return false;
			} else if (
				scrubbedTerminal ||
				(await sha256(evidence.sealed_capability)) !== entry.sealedCapabilitySha256
			) {
				return false;
			}
		}
		return true;
	}
}

function fromRecipientRow(row: RecipientRow): Recipient {
	return {
		id: row.id,
		envelopeId: row.envelope_id,
		email: row.email,
		name: row.name,
		role: row.role,
		locale: row.locale,
		routingOrder: row.routing_order,
		status: row.status
	};
}

function validAuditEvidence(row: SendCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'envelope.sent' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at
	);
}

async function validStoredReceipt(row: SendCommandRow): Promise<boolean> {
	const requestHash: string = await sha256(
		JSON.stringify({
			expectedGeneration: row.expected_generation,
			expectedReadyAuditEventId: row.ready_audit_event_id
		})
	);
	if (
		requestHash !== row.request_hash ||
		(await sha256(row.delivery_manifest_json)) !== row.delivery_manifest_hash
	) {
		return false;
	}
	if (isDocumentSetReceipt(row)) {
		const documents = parseSentAuditDocuments(row.sent_documents_json);
		if (documents === null || documents.length !== row.document_count) return false;
		return (
			JSON.stringify({
				commitSha: row.commit_sha,
				generation: row.expected_generation,
				readyAuditEventId: row.ready_audit_event_id,
				initialRoutingOrder: row.initial_routing_order,
				queuedDeliveryCount: row.queued_delivery_count,
				reservedCapabilityCount: row.delivery_count,
				deliveryManifestHash: row.delivery_manifest_hash,
				initialCapabilityExpiresAt: row.initial_capability_expires_at,
				documentSetHash: row.document_set_hash,
				documentCount: row.document_count,
				documents
			}) === row.audit_payload_json
		);
	}
	if (isLegacySentPdfReceipt(row)) {
		return (
			JSON.stringify({
				commitSha: row.commit_sha,
				generation: row.expected_generation,
				readyAuditEventId: row.ready_audit_event_id,
				initialRoutingOrder: row.initial_routing_order,
				queuedDeliveryCount: row.queued_delivery_count,
				reservedCapabilityCount: row.delivery_count,
				deliveryManifestHash: row.delivery_manifest_hash,
				initialCapabilityExpiresAt: row.initial_capability_expires_at,
				sentPdfSha256: row.sent_pdf_sha256,
				sentPdfBytes: row.sent_pdf_bytes,
				sentPdfPageCount: row.sent_pdf_page_count
			}) === row.audit_payload_json
		);
	}
	return false;
}

function isDocumentSetReceipt(row: SendCommandRow): row is SendCommandRow & {
	document_set_hash: string;
	document_count: number;
	sent_documents_json: string;
} {
	return (
		row.document_set_hash !== null &&
		row.document_count !== null &&
		row.sent_documents_json !== null &&
		row.sent_pdf_object_key === null &&
		row.sent_pdf_sha256 === null &&
		row.sent_pdf_bytes === null &&
		row.sent_pdf_page_count === null &&
		row.sent_pdf_page_width === null &&
		row.sent_pdf_page_height === null &&
		row.sent_pdf_document_pages_json === null
	);
}

function isLegacySentPdfReceipt(row: SendCommandRow): boolean {
	return (
		row.document_set_hash === null &&
		row.document_count === null &&
		row.sent_documents_json === null &&
		row.sent_pdf_object_key !== null &&
		row.sent_pdf_sha256 !== null &&
		row.sent_pdf_bytes !== null &&
		row.sent_pdf_page_count !== null &&
		row.sent_pdf_page_width !== null &&
		row.sent_pdf_page_height !== null &&
		row.sent_pdf_document_pages_json !== null
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
		envelopeId: row.envelope_id,
		status: 'sent',
		generation: row.expected_generation,
		commitSha: row.commit_sha,
		readyAuditEventId: row.ready_audit_event_id,
		queuedDeliveryCount: row.queued_delivery_count,
		reservedCapabilityCount: row.delivery_count,
		initialCapabilityExpiresAt: row.initial_capability_expires_at,
		updatedAt: row.updated_at,
		auditEventId: row.audit_event_id
	};
}

function publishFromPreparation(preparation: SendPreparation): PublishSentEnvelopeResult {
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
