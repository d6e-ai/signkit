import postgres from 'postgres';
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
import { PostgresEnvelopeStore } from './postgres-envelope-store';

interface ReadyCommandRow {
	organizationId: string;
	envelopeId: string;
	actorType: string;
	actorId: string;
	requestHash: string;
	expectedGeneration: number;
	commitSha: string;
	recipientsJson: string;
	recipientCount: number;
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

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

export class PostgresEnvelopeReadyStore implements EnvelopeReadyStore {
	readonly #sql: ReturnType<typeof postgres>;
	readonly #envelopes: PostgresEnvelopeStore;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
		this.#envelopes = new PostgresEnvelopeStore(sql);
	}

	async prepareReady(key: ReadyCommandKey, expectedGeneration: number): Promise<ReadyPreparation> {
		const replay: ReadyPreparation | null = await this.#resolveCommand(this.#sql, key);
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
			this.#sql,
			key.organizationId,
			key.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return { outcome: 'ready', envelope, auditHead };
	}

	async publishReady(command: PublishReadyEnvelopeCommand): Promise<PublishReadyEnvelopeResult> {
		const replay: ReadyPreparation | null = await this.#resolveCommand(this.#sql, command);
		if (replay !== null) return publishFromPreparation(replay);

		try {
			return await this.#sql.begin(async (transaction): Promise<PublishReadyEnvelopeResult> => {
				const lockedRows = await transaction<
					{ status: string; repositoryGeneration: number; repositoryHead: string | null }[]
				>`
						SELECT status, repository_generation AS "repositoryGeneration",
							repository_head AS "repositoryHead"
						FROM envelope
						WHERE organization_id = ${command.organizationId} AND id = ${command.envelopeId}
						FOR UPDATE
					`;
				if (lockedRows.length === 0) return { outcome: 'not_found' };

				const raced: ReadyPreparation | null = await this.#resolveCommand(transaction, command);
				if (raced !== null) return publishFromPreparation(raced);

				const locked = lockedRows[0];
				if (locked.status !== 'draft') return { outcome: 'immutable' };
				if (locked.repositoryGeneration !== command.expectedGeneration) {
					return { outcome: 'generation_conflict' };
				}
				if (locked.repositoryHead === null || locked.repositoryGeneration < 1) {
					return { outcome: 'empty_draft' };
				}
				if (locked.repositoryHead !== command.expectedCommitSha) {
					return { outcome: 'integrity_error' };
				}

				const auditHead: ReadyAuditHead | null = await this.#readAuditHead(
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

				const updatedRows = await transaction<{ id: string }[]>`
						UPDATE envelope
						SET status = 'ready', updated_at = ${command.updatedAt}
						WHERE organization_id = ${command.organizationId}
							AND id = ${command.envelopeId}
							AND status = 'draft'
							AND repository_generation = ${command.expectedGeneration}
							AND repository_head = ${command.expectedCommitSha}
						RETURNING id
					`;
				if (updatedRows.length !== 1) return { outcome: 'generation_conflict' };

				await transaction`
						INSERT INTO envelope_ready_command (
							organization_id, envelope_id, actor_type, actor_id, idempotency_key, request_hash,
							expected_generation, commit_sha, recipients_json, recipient_count,
							updated_at, audit_event_id, audit_sequence, previous_audit_hash,
							audit_event_hash, audit_payload_json
						) VALUES (
							${command.organizationId}, ${command.envelopeId}, ${command.actorType}, ${command.actorId},
							${command.idempotencyKey}, ${command.requestFingerprint},
							${command.expectedGeneration}, ${command.expectedCommitSha},
							${JSON.stringify(command.recipients)}, ${command.recipients.length},
							${command.updatedAt}, ${command.auditEventId},
							${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
							${command.auditEventHash}, ${command.auditPayloadJson}
						)
					`;

				await transaction`
						DELETE FROM recipient
						WHERE organization_id = ${command.organizationId} AND envelope_id = ${command.envelopeId}
					`;
				for (const recipient of command.recipients) {
					await transaction`
							INSERT INTO recipient (
								id, organization_id, envelope_id, email, name, role, locale,
								routing_order, status, capability_hash, capability_expires_at,
								capability_revoked_at, created_at, updated_at
							) VALUES (
								${recipient.id}, ${recipient.organizationId}, ${recipient.envelopeId},
								${recipient.email}, ${recipient.name}, ${recipient.role}, ${recipient.locale},
								${recipient.routingOrder}, ${recipient.status}, NULL, NULL, NULL,
								${command.updatedAt}, ${command.updatedAt}
							)
						`;
				}

				await transaction`
						INSERT INTO audit_event (
							id, organization_id, envelope_id, sequence, event_type, actor_type,
							actor_id, payload_json, previous_hash, event_hash, occurred_at
						) VALUES (
							${command.auditEventId}, ${command.organizationId}, ${command.envelopeId},
							${command.expectedAuditSequence + 1}, 'envelope.ready', ${command.actorType},
							${command.actorId}, ${command.auditPayloadJson}, ${command.previousAuditHash},
							${command.auditEventHash}, ${command.updatedAt}
						)
					`;

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: ReadyPreparation = await this.prepareReady(
				command,
				command.expectedGeneration
			);
			if (classified.outcome !== 'ready') return publishFromPreparation(classified);
			throw error;
		}
	}

	async #resolveCommand(
		sql: ReturnType<typeof postgres> | postgres.TransactionSql,
		key: ReadyCommandKey
	): Promise<ReadyPreparation | null> {
		const rows = await sql<ReadyCommandRow[]>`
			SELECT command.organization_id AS "organizationId",
				command.envelope_id AS "envelopeId", command.actor_type AS "actorType",
				command.actor_id AS "actorId",
				command.request_hash AS "requestHash",
				command.expected_generation AS "expectedGeneration",
				command.commit_sha AS "commitSha", command.recipients_json AS "recipientsJson",
				command.recipient_count AS "recipientCount", command.updated_at AS "updatedAt",
				command.audit_event_id AS "auditEventId", command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash",
				command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson",
				evidence.id AS "evidenceEventId",
				evidence.organization_id AS "evidenceOrganizationId",
				evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence",
				evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType",
				evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson",
				evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash",
				evidence.occurred_at AS "evidenceOccurredAt"
			FROM envelope_ready_command command
			LEFT JOIN audit_event evidence
				ON evidence.organization_id = command.organization_id
				AND evidence.id = command.audit_event_id
			WHERE command.organization_id = ${key.organizationId}
				AND command.actor_type = ${key.actorType}
				AND command.actor_id = ${key.actorId}
				AND command.idempotency_key = ${key.idempotencyKey}
			LIMIT 1
		`;
		const row: ReadyCommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (row.envelopeId !== key.envelopeId || row.requestHash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!validAuditEvidence(row)) return { outcome: 'integrity_error' };
		const recipients: readonly Recipient[] | null = parseRecipients(row.recipientsJson);
		if (recipients === null || recipients.length !== row.recipientCount) {
			return { outcome: 'integrity_error' };
		}
		if (!(await validStoredReceipt(row, recipients))) return { outcome: 'integrity_error' };
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelopeId,
				status: 'ready',
				generation: row.expectedGeneration,
				commitSha: row.commitSha,
				recipients,
				updatedAt: isoTimestamp(row.updatedAt),
				auditEventId: row.auditEventId
			}
		};
	}

	async #readAuditHead(
		sql: ReturnType<typeof postgres> | postgres.TransactionSql,
		organizationId: string,
		envelopeId: string
	): Promise<ReadyAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash"
			FROM audit_event
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY sequence DESC LIMIT 1
		`;
		const row: AuditHeadRow | undefined = rows[0];
		if (row === undefined) return null;
		const sequence: number = typeof row.sequence === 'number' ? row.sequence : Number(row.sequence);
		if (!Number.isSafeInteger(sequence) || sequence < 1 || row.eventHash.length === 0) return null;
		return { sequence, eventHash: row.eventHash };
	}
}

function validAuditEvidence(row: ReadyCommandRow): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceOrganizationId === row.organizationId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'envelope.ready' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt)
	);
}

async function validStoredReceipt(
	row: ReadyCommandRow,
	recipients: readonly Recipient[]
): Promise<boolean> {
	if (
		recipients.some(
			(recipient: Recipient): boolean =>
				recipient.organizationId !== row.organizationId ||
				recipient.envelopeId !== row.envelopeId ||
				recipient.status !== 'pending'
		)
	) {
		return false;
	}
	const canonicalRequest: string = JSON.stringify({
		expectedGeneration: row.expectedGeneration,
		recipients: recipients.map((recipient: Recipient) => ({
			email: recipient.email,
			name: recipient.name,
			role: recipient.role,
			locale: recipient.locale,
			routingOrder: recipient.routingOrder
		}))
	});
	const expectedAuditPayload: string = JSON.stringify({
		commitSha: row.commitSha,
		generation: row.expectedGeneration,
		recipients: recipients.map((recipient: Recipient) => ({
			id: recipient.id,
			role: recipient.role,
			routingOrder: recipient.routingOrder
		}))
	});
	return (
		(await sha256(canonicalRequest)) === row.requestHash &&
		expectedAuditPayload === row.auditPayloadJson
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

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sameTimestamp(left: Date | string | null, right: Date | string): boolean {
	if (left === null) return false;
	return isoTimestamp(left) === isoTimestamp(right);
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
