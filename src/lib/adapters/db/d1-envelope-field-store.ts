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
import { D1EnvelopeStore } from './d1-envelope-store';

interface FieldCommandRow {
	organization_id: string;
	envelope_id: string;
	actor_type: string;
	actor_id: string;
	request_hash: string;
	expected_generation: number;
	expected_field_generation: number;
	commit_sha: string;
	fields_json: string;
	field_count: number;
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

export class D1EnvelopeFieldStore implements EnvelopeFieldStore {
	readonly #database: D1Database;
	readonly #envelopes: D1EnvelopeStore;

	constructor(database: D1Database) {
		this.#database = database;
		this.#envelopes = new D1EnvelopeStore(database);
	}

	async prepareFieldPlacement(
		key: FieldCommandKey,
		expectedGeneration: number,
		expectedFieldGeneration: number
	): Promise<FieldPlacementPreparation> {
		const replay: FieldPlacementPreparation | null = await this.#resolveCommand(key);
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
			key.organizationId,
			key.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const recipients: readonly Recipient[] = await this.#readRecipients(
			key.organizationId,
			key.envelopeId
		);
		return { outcome: 'ready', envelope, recipients, auditHead };
	}

	async publishFieldPlacement(
		command: PublishFieldPlacementCommand
	): Promise<PublishFieldPlacementResult> {
		const replay: FieldPlacementPreparation | null = await this.#resolveCommand(command);
		if (replay !== null) return publishFromPreparation(replay);

		const statements: D1PreparedStatement[] = [
			this.#database
				.prepare(
					`INSERT INTO envelope_field_placement_command (
						organization_id, envelope_id, actor_type, actor_id, idempotency_key, request_hash,
						expected_generation, expected_field_generation, commit_sha, fields_json, field_count,
						updated_at, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					command.organizationId,
					command.envelopeId,
					command.actorType,
					command.actorId,
					command.idempotencyKey,
					command.requestFingerprint,
					command.expectedGeneration,
					command.expectedFieldGeneration,
					command.expectedCommitSha,
					JSON.stringify(command.fields),
					command.fields.length,
					command.updatedAt,
					command.auditEventId,
					command.expectedAuditSequence + 1,
					command.previousAuditHash,
					command.auditEventHash,
					command.auditPayloadJson
				),
			this.#database
				.prepare('DELETE FROM envelope_field WHERE organization_id = ? AND envelope_id = ?')
				.bind(command.organizationId, command.envelopeId),
			...command.fields.map((field: EnvelopeField): D1PreparedStatement =>
				this.#database
					.prepare(
						`INSERT INTO envelope_field (
							id, organization_id, envelope_id, recipient_id, document_path, field_type,
							label, required, position, page, x, y, width, height, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						field.id,
						field.organizationId,
						field.envelopeId,
						field.recipientId,
						field.documentPath,
						field.fieldType,
						field.label,
						field.required ? 1 : 0,
						field.position,
						field.geometry?.page ?? null,
						field.geometry?.x ?? null,
						field.geometry?.y ?? null,
						field.geometry?.width ?? null,
						field.geometry?.height ?? null,
						command.updatedAt,
						command.updatedAt
					)
			)
		];

		try {
			await this.#database.batch(statements);
			return { outcome: 'published', result: resultFromCommand(command) };
		} catch (error: unknown) {
			const raced: FieldPlacementPreparation | null = await this.#resolveCommand(command);
			if (raced !== null) return publishFromPreparation(raced);
			const classified: PublishFieldPlacementResult | null = await this.#classifyFailure(command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async #resolveCommand(key: FieldCommandKey): Promise<FieldPlacementPreparation | null> {
		const row: FieldCommandRow | null = await this.#database
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
				 FROM envelope_field_placement_command command
				 LEFT JOIN audit_event evidence
					ON evidence.organization_id = command.organization_id
					AND evidence.id = command.audit_event_id
				 WHERE command.organization_id = ? AND command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(key.organizationId, key.actorType, key.actorId, key.idempotencyKey)
			.first<FieldCommandRow>();
		if (row === null) return null;
		if (row.envelope_id !== key.envelopeId || row.request_hash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!validAuditEvidence(row)) return { outcome: 'integrity_error' };
		const fields: readonly EnvelopeField[] | null = parseFields(row.fields_json);
		if (fields === null || fields.length !== row.field_count) {
			return { outcome: 'integrity_error' };
		}
		if (!(await validStoredReceipt(row, fields))) return { outcome: 'integrity_error' };
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelope_id,
				generation: row.expected_generation,
				fieldGeneration: row.expected_field_generation + 1,
				commitSha: row.commit_sha,
				fields: fields.map(toPublicField),
				updatedAt: row.updated_at,
				auditEventId: row.audit_event_id
			}
		};
	}

	async #readAuditHead(organizationId: string, envelopeId: string): Promise<FieldAuditHead | null> {
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

	async #readRecipients(organizationId: string, envelopeId: string): Promise<readonly Recipient[]> {
		const result = await this.#database
			.prepare(
				`SELECT id, organization_id, envelope_id, email, name, role, locale,
					routing_order, status
				 FROM recipient WHERE organization_id = ? AND envelope_id = ?
				 ORDER BY routing_order, id`
			)
			.bind(organizationId, envelopeId)
			.all<{
				id: string;
				organization_id: string;
				envelope_id: string;
				email: string;
				name: string;
				role: string;
				locale: string;
				routing_order: number;
				status: string;
			}>();
		return result.results.map((row): Recipient => ({
			id: row.id,
			organizationId: row.organization_id,
			envelopeId: row.envelope_id,
			email: row.email,
			name: row.name,
			role: row.role as Recipient['role'],
			locale: row.locale as Recipient['locale'],
			routingOrder: row.routing_order,
			status: row.status as Recipient['status']
		}));
	}

	async #classifyFailure(
		command: PublishFieldPlacementCommand
	): Promise<PublishFieldPlacementResult | null> {
		const preparation: FieldPlacementPreparation = await this.prepareFieldPlacement(
			command,
			command.expectedGeneration,
			command.expectedFieldGeneration
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
		const signerIds: Set<string> = new Set(
			preparation.recipients
				.filter((recipient: Recipient): boolean => recipient.role === 'signer')
				.map((recipient: Recipient): string => recipient.id)
		);
		if (command.fields.some((field: EnvelopeField): boolean => !signerIds.has(field.recipientId))) {
			return { outcome: 'invalid_recipient' };
		}
		return null;
	}
}

function validAuditEvidence(row: FieldCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_organization_id === row.organization_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'envelope.fields_placed' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at
	);
}

async function validStoredReceipt(
	row: FieldCommandRow,
	fields: readonly EnvelopeField[]
): Promise<boolean> {
	if (
		fields.some(
			(field: EnvelopeField): boolean =>
				field.organizationId !== row.organization_id || field.envelopeId !== row.envelope_id
		)
	) {
		return false;
	}
	const canonicalRequest: string = JSON.stringify({
		expectedGeneration: row.expected_generation,
		expectedFieldGeneration: row.expected_field_generation,
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
		commitSha: row.commit_sha,
		generation: row.expected_generation,
		fieldGeneration: row.expected_field_generation + 1,
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
		(await sha256(canonicalRequest)) === row.request_hash &&
		expectedAuditPayload === row.audit_payload_json
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
