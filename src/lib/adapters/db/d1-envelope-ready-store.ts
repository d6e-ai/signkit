import type { Envelope, Recipient, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
import type {
	EnvelopeReadyStore,
	PublishReadyEnvelopeCommand,
	PublishReadyEnvelopeResult,
	PublishedReadyEnvelope,
	ReadyAuditHead,
	ReadyCommandKey,
	ReadyPreparation
} from '$lib/ports/envelope-ready-store';
import { D1EnvelopeStore } from './d1-envelope-store';

interface ReadyCommandRow {
	organization_id: string;
	envelope_id: string;
	actor_type: string;
	actor_id: string;
	request_hash: string;
	expected_generation: number;
	commit_sha: string;
	recipients_json: string;
	recipient_count: number;
	updated_at: string;
	audit_event_id: string;
	audit_sequence: number;
	previous_audit_hash: string;
	audit_event_hash: string;
	audit_payload_json: string;
	evidence_event_id: string | null;
	evidence_organization_id: string | null;
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

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

export class D1EnvelopeReadyStore implements EnvelopeReadyStore {
	readonly #database: D1Database;
	readonly #envelopes: D1EnvelopeStore;

	constructor(database: D1Database) {
		this.#database = database;
		this.#envelopes = new D1EnvelopeStore(database);
	}

	async prepareReady(key: ReadyCommandKey, expectedGeneration: number): Promise<ReadyPreparation> {
		const replay: ReadyPreparation | null = await this.#resolveCommand(key);
		if (replay !== null) return replay;

		const envelope: Envelope | null = await this.#envelopes.findForOrganization(
			key.organizationId,
			key.envelopeId
		);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'draft') return { outcome: 'immutable' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		if (envelope.repositoryHead === null || envelope.repositoryGeneration < 1) {
			return { outcome: 'empty_draft' };
		}
		const auditHead: ReadyAuditHead | null = await this.#readAuditHead(
			key.organizationId,
			key.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return { outcome: 'ready', envelope, auditHead };
	}

	async publishReady(command: PublishReadyEnvelopeCommand): Promise<PublishReadyEnvelopeResult> {
		const replay: ReadyPreparation | null = await this.#resolveCommand(command);
		if (replay !== null) return publishFromPreparation(replay);

		const statements: D1PreparedStatement[] = [
			this.#database
				.prepare(
					`INSERT INTO envelope_ready_command (
						organization_id, envelope_id, actor_type, actor_id, idempotency_key, request_hash,
						expected_generation, commit_sha, recipients_json, recipient_count,
						updated_at, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					command.organizationId,
					command.envelopeId,
					command.actorType,
					command.actorId,
					command.idempotencyKey,
					command.requestFingerprint,
					command.expectedGeneration,
					command.expectedCommitSha,
					JSON.stringify(command.recipients),
					command.recipients.length,
					command.updatedAt,
					command.auditEventId,
					command.expectedAuditSequence + 1,
					command.previousAuditHash,
					command.auditEventHash,
					command.auditPayloadJson
				),
			this.#database
				.prepare('DELETE FROM recipient WHERE organization_id = ? AND envelope_id = ?')
				.bind(command.organizationId, command.envelopeId),
			...command.recipients.map((recipient: Recipient): D1PreparedStatement =>
				this.#database
					.prepare(
						`INSERT INTO recipient (
							id, organization_id, envelope_id, email, name, role, locale,
							routing_order, status, capability_hash, capability_expires_at,
							capability_revoked_at, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
					)
					.bind(
						recipient.id,
						recipient.organizationId,
						recipient.envelopeId,
						recipient.email,
						recipient.name,
						recipient.role,
						recipient.locale,
						recipient.routingOrder,
						recipient.status,
						command.updatedAt,
						command.updatedAt
					)
			)
		];

		try {
			await this.#database.batch(statements);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			const raced: ReadyPreparation | null = await this.#resolveCommand(command);
			if (raced !== null) return publishFromPreparation(raced);
			const classified: PublishReadyEnvelopeResult | null = await this.#classifyFailure(command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async #resolveCommand(key: ReadyCommandKey): Promise<ReadyPreparation | null> {
		const row: ReadyCommandRow | null = await this.#database
			.prepare(
				`SELECT command.*,
					evidence.id AS evidence_event_id,
					evidence.organization_id AS evidence_organization_id,
					evidence.envelope_id AS evidence_envelope_id,
					evidence.sequence AS evidence_sequence,
					evidence.event_type AS evidence_event_type,
					evidence.actor_type AS evidence_actor_type,
					evidence.actor_id AS evidence_actor_id,
					evidence.payload_json AS evidence_payload_json,
					evidence.previous_hash AS evidence_previous_hash,
					evidence.event_hash AS evidence_event_hash,
					evidence.occurred_at AS evidence_occurred_at
				 FROM envelope_ready_command command
				 LEFT JOIN audit_event evidence
					ON evidence.organization_id = command.organization_id
					AND evidence.id = command.audit_event_id
				 WHERE command.organization_id = ? AND command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(key.organizationId, key.actorType, key.actorId, key.idempotencyKey)
			.first<ReadyCommandRow>();
		if (row === null) return null;
		if (row.envelope_id !== key.envelopeId || row.request_hash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!validAuditEvidence(row)) return { outcome: 'integrity_error' };
		const recipients: readonly Recipient[] | null = parseRecipients(row.recipients_json);
		if (recipients === null || recipients.length !== row.recipient_count) {
			return { outcome: 'integrity_error' };
		}
		if (!(await validStoredReceipt(row, recipients))) return { outcome: 'integrity_error' };
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelope_id,
				status: 'ready',
				generation: row.expected_generation,
				commitSha: row.commit_sha,
				recipients,
				updatedAt: row.updated_at,
				auditEventId: row.audit_event_id
			}
		};
	}

	async #readAuditHead(organizationId: string, envelopeId: string): Promise<ReadyAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ?
				 ORDER BY sequence DESC LIMIT 1`
			)
			.bind(organizationId, envelopeId)
			.first<AuditHeadRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #classifyFailure(
		command: PublishReadyEnvelopeCommand
	): Promise<PublishReadyEnvelopeResult | null> {
		const preparation: ReadyPreparation = await this.prepareReady(
			command,
			command.expectedGeneration
		);
		if (preparation.outcome !== 'ready') return publishFromPreparation(preparation);
		if (
			preparation.auditHead.sequence !== command.expectedAuditSequence ||
			preparation.auditHead.eventHash !== command.previousAuditHash
		) {
			return { outcome: 'audit_conflict' };
		}
		if (preparation.envelope.repositoryHead !== command.expectedCommitSha) {
			return { outcome: 'integrity_error' };
		}
		return null;
	}
}

function validAuditEvidence(row: ReadyCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_organization_id === row.organization_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'envelope.ready' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at
	);
}

async function validStoredReceipt(
	row: ReadyCommandRow,
	recipients: readonly Recipient[]
): Promise<boolean> {
	if (
		recipients.some(
			(recipient: Recipient): boolean =>
				recipient.organizationId !== row.organization_id ||
				recipient.envelopeId !== row.envelope_id ||
				recipient.status !== 'pending'
		)
	) {
		return false;
	}
	const canonicalRequest: string = JSON.stringify({
		expectedGeneration: row.expected_generation,
		recipients: recipients.map((recipient: Recipient) => ({
			email: recipient.email,
			name: recipient.name,
			role: recipient.role,
			locale: recipient.locale,
			routingOrder: recipient.routingOrder
		}))
	});
	const expectedAuditPayload: string = JSON.stringify({
		commitSha: row.commit_sha,
		generation: row.expected_generation,
		recipients: recipients.map((recipient: Recipient) => ({
			id: recipient.id,
			role: recipient.role,
			routingOrder: recipient.routingOrder
		}))
	});
	return (
		(await sha256(canonicalRequest)) === row.request_hash &&
		expectedAuditPayload === row.audit_payload_json
	);
}

function parseRecipients(value: string): readonly Recipient[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const recipients: Recipient[] = [];
	for (const candidate of parsed) {
		if (!isRecipient(candidate)) return null;
		recipients.push(candidate);
	}
	return recipients;
}

function isRecipient(value: unknown): value is Recipient {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.organizationId === 'string' &&
		typeof candidate.envelopeId === 'string' &&
		typeof candidate.email === 'string' &&
		typeof candidate.name === 'string' &&
		isRecipientRole(candidate.role) &&
		(candidate.locale === 'en' || candidate.locale === 'ja') &&
		typeof candidate.routingOrder === 'number' &&
		Number.isSafeInteger(candidate.routingOrder) &&
		isRecipientStatus(candidate.status)
	);
}

function isRecipientRole(value: unknown): value is RecipientRole {
	return ['signer', 'approver', 'viewer', 'prefill', 'cc'].includes(String(value));
}

function isRecipientStatus(value: unknown): value is RecipientStatus {
	return ['pending', 'viewed', 'completed', 'declined'].includes(String(value));
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

function resultFromCommand(command: PublishReadyEnvelopeCommand): PublishedReadyEnvelope {
	return {
		envelopeId: command.envelopeId,
		status: 'ready',
		generation: command.expectedGeneration,
		commitSha: command.expectedCommitSha,
		recipients: command.recipients,
		updatedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}

function publishFromPreparation(preparation: ReadyPreparation): PublishReadyEnvelopeResult {
	if (preparation.outcome === 'replayed') return preparation;
	if (preparation.outcome === 'idempotency_conflict') return preparation;
	if (preparation.outcome === 'not_found') return preparation;
	if (preparation.outcome === 'immutable') return preparation;
	if (preparation.outcome === 'generation_conflict') return preparation;
	if (preparation.outcome === 'audit_conflict') return preparation;
	if (preparation.outcome === 'empty_draft') return preparation;
	return { outcome: 'integrity_error' };
}
