import type {
	Envelope,
	EnvelopeField,
	FieldGeometry,
	FieldType,
	MarkdownPath,
	Recipient
} from '$lib/domain/envelope';
import {
	AuthoringFieldsIntegrityError,
	type AuthoringEnvelopeField,
	type AuthoringFieldsSnapshot,
	type EnvelopeFieldStore,
	type FieldAuditHead,
	type FieldCommandKey,
	type FieldPlacementPreparation,
	type PublicEnvelopeField,
	type PublishFieldPlacementCommand,
	type PublishFieldPlacementResult,
	type PublishedFieldPlacement
} from '$lib/ports/envelope-field-store';
import { D1EnvelopeStore } from './d1-envelope-store';

interface FieldCommandRow {
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

	async readAuthoringFields(envelopeId: string): Promise<AuthoringFieldsSnapshot | null> {
		const result = await this.#database
			.prepare(
				`SELECT envelope.repository_generation AS repository_generation,
				        envelope.field_generation AS field_generation,
				        envelope.repository_head AS repository_head,
				        envelope_field.id AS id,
				        envelope_field.recipient_id AS recipient_id,
				        envelope_field.document_id AS document_id,
				        envelope_field.document_path AS document_path,
				        envelope_field.field_type AS field_type,
				        envelope_field.label AS label,
				        envelope_field.required AS required,
				        envelope_field.position AS position,
				        envelope_field.page AS page,
				        envelope_field.x AS x,
				        envelope_field.y AS y,
				        envelope_field.width AS width,
				        envelope_field.height AS height
				 FROM envelope
				 LEFT JOIN envelope_field ON envelope_field.envelope_id = envelope.id
				 WHERE envelope.id = ?
				 ORDER BY COALESCE(envelope_field.document_id, envelope_field.document_path) ASC,
				          envelope_field.position ASC, envelope_field.id ASC`
			)
			.bind(envelopeId)
			.all<AuthoringJoinRow>();
		return snapshotFromJoinRows(envelopeId, result.results);
	}

	async prepareFieldPlacement(
		key: FieldCommandKey,
		expectedGeneration: number,
		expectedFieldGeneration: number
	): Promise<FieldPlacementPreparation> {
		const replay: FieldPlacementPreparation | null = await this.#resolveCommand(key);
		if (replay !== null) return replay;

		const envelope: Envelope | null = await this.#envelopes.findEnvelope(key.envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'ready') return { outcome: 'not_ready' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}
		if (envelope.fieldGeneration !== expectedFieldGeneration) {
			return { outcome: 'field_generation_conflict' };
		}
		if (envelope.repositoryHead === null) return { outcome: 'integrity_error' };
		const auditHead: FieldAuditHead | null = await this.#readAuditHead(key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		const recipients: readonly Recipient[] = await this.#readRecipients(key.envelopeId);
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
						envelope_id, actor_type, actor_id, idempotency_key, request_hash,
						expected_generation, expected_field_generation, commit_sha, fields_json, field_count,
						updated_at, audit_event_id, audit_sequence, previous_audit_hash,
						audit_event_hash, audit_payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
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
				.prepare('DELETE FROM envelope_field WHERE envelope_id = ?')
				.bind(command.envelopeId),
			...command.fields.map((field: EnvelopeField): D1PreparedStatement =>
				this.#database
					.prepare(
						`INSERT INTO envelope_field (
							id, envelope_id, recipient_id, document_id, document_path, field_type,
							label, required, position, page, x, y, width, height, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						field.id,
						field.envelopeId,
						field.recipientId,
						field.documentId,
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
					ON evidence.id = command.audit_event_id
				 WHERE command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(key.actorType, key.actorId, key.idempotencyKey)
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

	async #readAuditHead(envelopeId: string): Promise<FieldAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE envelope_id = ?
				 ORDER BY sequence DESC LIMIT 1`
			)
			.bind(envelopeId)
			.first<AuditHeadRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #readRecipients(envelopeId: string): Promise<readonly Recipient[]> {
		const result = await this.#database
			.prepare(
				`SELECT id, envelope_id, email, name, role, locale,
					routing_order, status
				 FROM recipient WHERE envelope_id = ?
				 ORDER BY routing_order, id`
			)
			.bind(envelopeId)
			.all<{
				id: string;
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
	if (fields.some((field: EnvelopeField): boolean => field.envelopeId !== row.envelope_id)) {
		return false;
	}
	const canonicalRequest: string = JSON.stringify({
		expectedGeneration: row.expected_generation,
		expectedFieldGeneration: row.expected_field_generation,
		fields: fields.map((field: EnvelopeField) => ({
			recipientId: field.recipientId,
			documentId: field.documentId,
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
			documentId: field.documentId,
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
		typeof candidate.envelopeId === 'string' &&
		typeof candidate.recipientId === 'string' &&
		isDocumentScope(candidate) &&
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

interface AuthoringJoinRow {
	repository_generation: number;
	field_generation: number;
	repository_head: string | null;
	id: string | null;
	recipient_id: string | null;
	document_id: string | null;
	document_path: string | null;
	field_type: string | null;
	label: string | null;
	required: number | boolean | null;
	position: number | null;
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}

function snapshotFromJoinRows(
	envelopeId: string,
	rows: readonly AuthoringJoinRow[]
): AuthoringFieldsSnapshot | null {
	const first: AuthoringJoinRow | undefined = rows[0];
	if (first === undefined) return null;
	if (!Number.isSafeInteger(first.repository_generation) || first.repository_generation < 0) {
		throw new AuthoringFieldsIntegrityError('Authoring envelope generation is corrupt');
	}
	if (!Number.isSafeInteger(first.field_generation) || first.field_generation < 0) {
		throw new AuthoringFieldsIntegrityError('Authoring field generation is corrupt');
	}
	const fields: AuthoringEnvelopeField[] = [];
	for (const row of rows) {
		if (row.field_generation !== first.field_generation) {
			throw new AuthoringFieldsIntegrityError('Authoring field generation is not coherent');
		}
		if (row.id === null) {
			if (fields.length > 0) {
				throw new AuthoringFieldsIntegrityError(
					'Authoring field snapshot mixed empty and placed rows'
				);
			}
			continue;
		}
		fields.push(authoringFieldFromJoinRow(row));
	}
	return {
		envelopeId,
		generation: first.repository_generation,
		fieldGeneration: first.field_generation,
		commitSha: first.repository_head,
		fields
	};
}

function authoringFieldFromJoinRow(row: AuthoringJoinRow): AuthoringEnvelopeField {
	if (
		typeof row.id !== 'string' ||
		typeof row.recipient_id !== 'string' ||
		!isFieldType(row.field_type) ||
		typeof row.label !== 'string' ||
		row.label.length === 0 ||
		typeof row.position !== 'number' ||
		!Number.isSafeInteger(row.position)
	) {
		throw new AuthoringFieldsIntegrityError('Authoring field row is incomplete or invalid');
	}
	const required: boolean | null =
		row.required === true || row.required === 1
			? true
			: row.required === false || row.required === 0
				? false
				: null;
	if (required === null) {
		throw new AuthoringFieldsIntegrityError('Authoring field row is incomplete or invalid');
	}
	if (row.document_id !== null && typeof row.document_id !== 'string') {
		throw new AuthoringFieldsIntegrityError('Authoring field row is incomplete or invalid');
	}
	if (row.document_path !== null && typeof row.document_path !== 'string') {
		throw new AuthoringFieldsIntegrityError('Authoring field row is incomplete or invalid');
	}
	return {
		id: row.id,
		recipientId: row.recipient_id,
		documentId: row.document_id,
		documentPath: row.document_path as MarkdownPath | null,
		fieldType: row.field_type,
		label: row.label,
		required,
		position: row.position,
		geometry: geometryFromColumns(row.page, row.x, row.y, row.width, row.height)
	};
}

function geometryFromColumns(
	page: number | null,
	x: number | null,
	y: number | null,
	width: number | null,
	height: number | null
): FieldGeometry | null {
	const present: number =
		(page === null ? 0 : 1) +
		(x === null ? 0 : 1) +
		(y === null ? 0 : 1) +
		(width === null ? 0 : 1) +
		(height === null ? 0 : 1);
	if (present === 0) return null;
	if (present !== 5) {
		throw new AuthoringFieldsIntegrityError('Authoring field geometry is incomplete');
	}
	return {
		page: page as number,
		x: x as number,
		y: y as number,
		width: width as number,
		height: height as number
	};
}

function toPublicField(field: EnvelopeField): PublicEnvelopeField {
	return {
		id: field.id,
		recipientId: field.recipientId,
		documentId: field.documentId,
		documentPath: field.documentPath,
		fieldType: field.fieldType,
		required: field.required,
		position: field.position,
		geometry: field.geometry
	};
}

function isDocumentScope(candidate: Record<string, unknown>): boolean {
	const hasId: boolean = typeof candidate.documentId === 'string';
	const hasPath: boolean = typeof candidate.documentPath === 'string';
	return (hasId && candidate.documentPath === null) || (candidate.documentId === null && hasPath);
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
