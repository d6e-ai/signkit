import postgres from 'postgres';
import type {
	Envelope,
	EnvelopeField,
	FieldGeometry,
	FieldType,
	Recipient
} from '$lib/domain/envelope';
import type {
	EnvelopeFieldStore,
	FieldAuditHead,
	FieldCommandKey,
	FieldPlacementPreparation,
	PublicEnvelopeField,
	PublishFieldPlacementCommand,
	PublishFieldPlacementResult,
	PublishedFieldPlacement
} from '$lib/ports/envelope-field-store';
import { PostgresEnvelopeStore } from './postgres-envelope-store';

interface FieldCommandRow {
	organizationId: string;
	envelopeId: string;
	actorType: string;
	actorId: string;
	requestHash: string;
	expectedGeneration: number;
	expectedFieldGeneration: number;
	commitSha: string;
	fieldsJson: string;
	fieldCount: number;
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

interface LockedEnvelopeRow {
	status: string;
	repositoryGeneration: number;
	repositoryHead: string | null;
	fieldGeneration: number;
}

interface LockedRecipientRow {
	id: string;
	role: string;
}

export class PostgresEnvelopeFieldStore implements EnvelopeFieldStore {
	readonly #sql: ReturnType<typeof postgres>;
	readonly #envelopes: PostgresEnvelopeStore;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
		this.#envelopes = new PostgresEnvelopeStore(sql);
	}

	async prepareFieldPlacement(
		key: FieldCommandKey,
		expectedGeneration: number,
		expectedFieldGeneration: number
	): Promise<FieldPlacementPreparation> {
		const replay: FieldPlacementPreparation | null = await this.#resolveCommand(this.#sql, key);
		if (replay !== null) return replay;

		const envelope: Envelope | null = await this.#envelopes.findForOrganization(
			key.organizationId,
			key.envelopeId
		);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'ready') return { outcome: 'not_ready' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		if (envelope.fieldGeneration !== expectedFieldGeneration) {
			return { outcome: 'field_generation_conflict' };
		}
		if (envelope.repositoryHead === null) return { outcome: 'integrity_error' };
		const auditHead: FieldAuditHead | null = await this.#readAuditHead(
			this.#sql,
			key.organizationId,
			key.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const recipients: readonly Recipient[] = await this.#readRecipients(
			this.#sql,
			key.organizationId,
			key.envelopeId
		);
		return { outcome: 'ready', envelope, recipients, auditHead };
	}

	async publishFieldPlacement(
		command: PublishFieldPlacementCommand
	): Promise<PublishFieldPlacementResult> {
		const replay: FieldPlacementPreparation | null = await this.#resolveCommand(this.#sql, command);
		if (replay !== null) return publishFromPreparation(replay);

		try {
			return await this.#sql.begin(async (transaction): Promise<PublishFieldPlacementResult> => {
				const lockedEnvelopeRows = await transaction<LockedEnvelopeRow[]>`
						SELECT status, repository_generation AS "repositoryGeneration",
							repository_head AS "repositoryHead", field_generation AS "fieldGeneration"
						FROM envelope
						WHERE organization_id = ${command.organizationId} AND id = ${command.envelopeId}
						FOR UPDATE
					`;
				if (lockedEnvelopeRows.length === 0) return { outcome: 'not_found' };

				const raced: FieldPlacementPreparation | null = await this.#resolveCommand(
					transaction,
					command
				);
				if (raced !== null) return publishFromPreparation(raced);

				const locked = lockedEnvelopeRows[0];
				if (locked.status !== 'ready') return { outcome: 'not_ready' };
				if (locked.repositoryGeneration !== command.expectedGeneration) {
					return { outcome: 'generation_conflict' };
				}
				if (locked.fieldGeneration !== command.expectedFieldGeneration) {
					return { outcome: 'field_generation_conflict' };
				}
				if (locked.repositoryHead !== command.expectedCommitSha) {
					return { outcome: 'integrity_error' };
				}

				const auditHead: FieldAuditHead | null = await this.#readAuditHead(
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

				// Lock referenced recipients in a stable order (sorted by ID) so
				// concurrent placement commands touching overlapping recipient sets
				// cannot deadlock against each other.
				const recipientIds: readonly string[] = [
					...new Set(command.fields.map((field: EnvelopeField): string => field.recipientId))
				].sort();
				const lockedRecipients = await transaction<LockedRecipientRow[]>`
						SELECT id, role FROM recipient
						WHERE organization_id = ${command.organizationId}
							AND envelope_id = ${command.envelopeId}
							AND id = ANY(${recipientIds})
						ORDER BY id
						FOR UPDATE
					`;
				const signerIds: Set<string> = new Set(
					lockedRecipients
						.filter((recipient: LockedRecipientRow): boolean => recipient.role === 'signer')
						.map((recipient: LockedRecipientRow): string => recipient.id)
				);
				if (recipientIds.some((id: string): boolean => !signerIds.has(id))) {
					return { outcome: 'invalid_recipient' };
				}

				const updatedRows = await transaction<{ id: string }[]>`
						UPDATE envelope
						SET field_generation = ${command.expectedFieldGeneration + 1},
							updated_at = ${command.updatedAt}
						WHERE organization_id = ${command.organizationId}
							AND id = ${command.envelopeId}
							AND status = 'ready'
							AND repository_generation = ${command.expectedGeneration}
							AND repository_head = ${command.expectedCommitSha}
							AND field_generation = ${command.expectedFieldGeneration}
						RETURNING id
					`;
				if (updatedRows.length !== 1) return { outcome: 'field_generation_conflict' };

				await transaction`
						DELETE FROM envelope_field
						WHERE organization_id = ${command.organizationId} AND envelope_id = ${command.envelopeId}
					`;
				for (const field of command.fields) {
					await transaction`
							INSERT INTO envelope_field (
								id, organization_id, envelope_id, recipient_id, document_path, field_type,
								label, required, position, page, x, y, width, height, created_at, updated_at
							) VALUES (
								${field.id}, ${field.organizationId}, ${field.envelopeId}, ${field.recipientId},
								${field.documentPath}, ${field.fieldType}, ${field.label}, ${field.required},
								${field.position}, ${field.geometry?.page ?? null}, ${field.geometry?.x ?? null},
								${field.geometry?.y ?? null}, ${field.geometry?.width ?? null},
								${field.geometry?.height ?? null}, ${command.updatedAt}, ${command.updatedAt}
							)
						`;
				}

				await transaction`
						INSERT INTO envelope_field_placement_command (
							organization_id, envelope_id, actor_type, actor_id, idempotency_key, request_hash,
							expected_generation, expected_field_generation, commit_sha, fields_json,
							field_count, updated_at, audit_event_id, audit_sequence, previous_audit_hash,
							audit_event_hash, audit_payload_json
						) VALUES (
							${command.organizationId}, ${command.envelopeId}, ${command.actorType}, ${command.actorId},
							${command.idempotencyKey}, ${command.requestFingerprint},
							${command.expectedGeneration}, ${command.expectedFieldGeneration},
							${command.expectedCommitSha}, ${JSON.stringify(command.fields)},
							${command.fields.length}, ${command.updatedAt}, ${command.auditEventId},
							${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
							${command.auditEventHash}, ${command.auditPayloadJson}
						)
					`;

				await transaction`
						INSERT INTO audit_event (
							id, organization_id, envelope_id, sequence, event_type, actor_type,
							actor_id, payload_json, previous_hash, event_hash, occurred_at
						) VALUES (
							${command.auditEventId}, ${command.organizationId}, ${command.envelopeId},
							${command.expectedAuditSequence + 1}, 'envelope.fields_placed', ${command.actorType},
							${command.actorId}, ${command.auditPayloadJson}, ${command.previousAuditHash},
							${command.auditEventHash}, ${command.updatedAt}
						)
					`;

				return { outcome: 'published', result: resultFromCommand(command) };
			});
		} catch (error: unknown) {
			const classified: FieldPlacementPreparation = await this.prepareFieldPlacement(
				command,
				command.expectedGeneration,
				command.expectedFieldGeneration
			);
			if (classified.outcome !== 'ready') return publishFromPreparation(classified);
			throw error;
		}
	}

	async #resolveCommand(
		sql: ReturnType<typeof postgres> | postgres.TransactionSql,
		key: FieldCommandKey
	): Promise<FieldPlacementPreparation | null> {
		const rows = await sql<FieldCommandRow[]>`
			SELECT command.organization_id AS "organizationId",
				command.envelope_id AS "envelopeId", command.actor_type AS "actorType",
				command.actor_id AS "actorId",
				command.request_hash AS "requestHash",
				command.expected_generation AS "expectedGeneration",
				command.expected_field_generation AS "expectedFieldGeneration",
				command.commit_sha AS "commitSha", command.fields_json AS "fieldsJson",
				command.field_count AS "fieldCount", command.updated_at AS "updatedAt",
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
			FROM envelope_field_placement_command command
			LEFT JOIN audit_event evidence
				ON evidence.organization_id = command.organization_id
				AND evidence.id = command.audit_event_id
			WHERE command.organization_id = ${key.organizationId}
				AND command.actor_type = ${key.actorType}
				AND command.actor_id = ${key.actorId}
				AND command.idempotency_key = ${key.idempotencyKey}
			LIMIT 1
		`;
		const row: FieldCommandRow | undefined = rows[0];
		if (row === undefined) return null;
		if (row.envelopeId !== key.envelopeId || row.requestHash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!validAuditEvidence(row)) return { outcome: 'integrity_error' };
		const fields: readonly EnvelopeField[] | null = parseFields(row.fieldsJson);
		if (fields === null || fields.length !== row.fieldCount) {
			return { outcome: 'integrity_error' };
		}
		if (!(await validStoredReceipt(row, fields))) return { outcome: 'integrity_error' };
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelopeId,
				generation: row.expectedGeneration,
				fieldGeneration: row.expectedFieldGeneration + 1,
				commitSha: row.commitSha,
				fields: fields.map(toPublicField),
				updatedAt: isoTimestamp(row.updatedAt),
				auditEventId: row.auditEventId
			}
		};
	}

	async #readAuditHead(
		sql: ReturnType<typeof postgres> | postgres.TransactionSql,
		organizationId: string,
		envelopeId: string
	): Promise<FieldAuditHead | null> {
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

	async #readRecipients(
		sql: ReturnType<typeof postgres> | postgres.TransactionSql,
		organizationId: string,
		envelopeId: string
	): Promise<readonly Recipient[]> {
		const rows = await sql<
			{
				id: string;
				organizationId: string;
				envelopeId: string;
				email: string;
				name: string;
				role: Recipient['role'];
				locale: Recipient['locale'];
				routingOrder: number;
				status: Recipient['status'];
			}[]
		>`
			SELECT id, organization_id AS "organizationId", envelope_id AS "envelopeId",
				email, name, role, locale, routing_order AS "routingOrder", status
			FROM recipient
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY routing_order, id
		`;
		return rows;
	}
}

function validAuditEvidence(row: FieldCommandRow): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceOrganizationId === row.organizationId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === Number(row.auditSequence) &&
		row.evidenceEventType === 'envelope.fields_placed' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt)
	);
}

async function validStoredReceipt(
	row: FieldCommandRow,
	fields: readonly EnvelopeField[]
): Promise<boolean> {
	if (
		fields.some(
			(field: EnvelopeField): boolean =>
				field.organizationId !== row.organizationId || field.envelopeId !== row.envelopeId
		)
	) {
		return false;
	}
	const canonicalRequest: string = JSON.stringify({
		expectedGeneration: row.expectedGeneration,
		expectedFieldGeneration: row.expectedFieldGeneration,
		fields: fields.map((field: EnvelopeField) => ({
			recipientId: field.recipientId,
			documentPath: field.documentPath,
			fieldType: field.fieldType,
			label: field.label,
			required: field.required,
			position: field.position,
			geometry: field.geometry
		}))
	});
	const expectedAuditPayload: string = JSON.stringify({
		commitSha: row.commitSha,
		generation: row.expectedGeneration,
		fieldGeneration: row.expectedFieldGeneration + 1,
		fields: fields.map((field: EnvelopeField) => ({
			id: field.id,
			recipientId: field.recipientId,
			documentPath: field.documentPath,
			fieldType: field.fieldType,
			required: field.required,
			position: field.position,
			geometry: field.geometry
		}))
	});
	return (
		(await sha256(canonicalRequest)) === row.requestHash &&
		expectedAuditPayload === row.auditPayloadJson
	);
}

function parseFields(value: string): readonly EnvelopeField[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const fields: EnvelopeField[] = [];
	for (const candidate of parsed) {
		if (!isEnvelopeField(candidate)) return null;
		fields.push(candidate);
	}
	return fields;
}

function isEnvelopeField(value: unknown): value is EnvelopeField {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.organizationId === 'string' &&
		typeof candidate.envelopeId === 'string' &&
		typeof candidate.recipientId === 'string' &&
		typeof candidate.documentPath === 'string' &&
		isFieldType(candidate.fieldType) &&
		typeof candidate.label === 'string' &&
		typeof candidate.required === 'boolean' &&
		typeof candidate.position === 'number' &&
		Number.isSafeInteger(candidate.position) &&
		isFieldGeometryOrNull(candidate.geometry)
	);
}

function isFieldGeometryOrNull(value: unknown): value is FieldGeometry | null {
	if (value === null) return true;
	if (typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.page === 'number' &&
		typeof candidate.x === 'number' &&
		typeof candidate.y === 'number' &&
		typeof candidate.width === 'number' &&
		typeof candidate.height === 'number'
	);
}

function isFieldType(value: unknown): value is FieldType {
	return ['signature', 'initials', 'text', 'date', 'checkbox'].includes(String(value));
}

function toPublicField(field: EnvelopeField): PublicEnvelopeField {
	return {
		id: field.id,
		recipientId: field.recipientId,
		documentPath: field.documentPath,
		fieldType: field.fieldType,
		required: field.required,
		position: field.position,
		geometry: field.geometry
	};
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

function resultFromCommand(command: PublishFieldPlacementCommand): PublishedFieldPlacement {
	return {
		envelopeId: command.envelopeId,
		generation: command.expectedGeneration,
		fieldGeneration: command.expectedFieldGeneration + 1,
		commitSha: command.expectedCommitSha,
		fields: command.fields.map(toPublicField),
		updatedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}

function publishFromPreparation(
	preparation: FieldPlacementPreparation
): PublishFieldPlacementResult {
	if (preparation.outcome === 'replayed') return preparation;
	if (preparation.outcome === 'idempotency_conflict') return preparation;
	if (preparation.outcome === 'not_found') return preparation;
	if (preparation.outcome === 'not_ready') return preparation;
	if (preparation.outcome === 'generation_conflict') return preparation;
	if (preparation.outcome === 'field_generation_conflict') return preparation;
	if (preparation.outcome === 'audit_conflict') return preparation;
	return { outcome: 'integrity_error' };
}
