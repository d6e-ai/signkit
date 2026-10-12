import type {
	CreateEnvelopeCommand,
	CreateEnvelopeStoreResult,
	EnvelopeApplicationStore,
	EnvelopeDetail,
	EnvelopeListPage,
	EnvelopeListQuery,
	PublicEnvelopeDetailField,
	PublicEnvelopeRecipient
} from '$lib/application/envelopes/model';
import {
	fieldTypes,
	recipientRoles,
	type Envelope,
	type EnvelopeStatus,
	type FieldGeometry,
	type FieldType,
	type MarkdownPath,
	type RecipientRole,
	type RecipientStatus
} from '$lib/domain/envelope';
import type {
	DraftAuditHead,
	DraftMutationStore,
	DraftRevisionKey,
	DraftRevisionPreparation,
	PersistedDraftRevisionLocator,
	PublishDraftRevisionCommand,
	PublishDraftRevisionResult,
	PublishedDraftRevision
} from '$lib/ports/draft-mutation-store';
import type { DraftPointerUpdate } from '$lib/ports/envelope-store';
import {
	D1_ENVELOPE_BY_ID_SQL,
	D1EnvelopeStore,
	d1EnvelopeFromRow,
	type D1EnvelopeRow
} from './d1-envelope-store';

const MAX_LIST_LIMIT: number = 100;

export const D1_ENVELOPE_DETAIL_RECIPIENT_SQL: string = `SELECT id, email, name, role, locale, routing_order, status
				 FROM recipient
				 WHERE envelope_id = ?
				 ORDER BY routing_order ASC, id ASC`;

export const D1_ENVELOPE_DETAIL_READY_SQL: string = `SELECT id
				 FROM audit_event
				 WHERE envelope_id = ? AND event_type = 'envelope.ready'
				 ORDER BY sequence DESC
				 LIMIT 1`;

export const D1_ENVELOPE_DETAIL_FIELD_SQL: string = `SELECT id, recipient_id, document_id, document_path, field_type, required, position,
				        page, x, y, width, height
				 FROM envelope_field
				 WHERE envelope_id = ?
				 ORDER BY COALESCE(document_id, document_path) ASC, position ASC, id ASC`;

interface IdempotencyRow {
	envelope_id: string;
	request_hash: string;
}

interface CursorRow {
	id: string;
	created_at: string;
}

interface DraftRevisionCommandRow {
	envelope_id: string;
	actor_type: string;
	actor_id: string;
	request_hash: string;
	resulting_generation: number;
	commit_sha: string;
	archive_key: string;
	archive_sha256: string;
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

/**
 * D1 implementation of the application-level envelope store. Creation uses
 * D1's native batch transaction so the envelope, audit event, and idempotency
 * record either all become visible or none of them do.
 */
export class D1EnvelopeApplicationStore implements EnvelopeApplicationStore, DraftMutationStore {
	readonly #database: D1Database;
	readonly #envelopes: D1EnvelopeStore;

	constructor(database: D1Database) {
		this.#database = database;
		this.#envelopes = new D1EnvelopeStore(database);
	}

	async createIdempotently(command: CreateEnvelopeCommand): Promise<CreateEnvelopeStoreResult> {
		const existing: CreateEnvelopeStoreResult | null = await this.#resolveIdempotency(command);
		if (existing !== null) return existing;

		const envelope: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO envelope (
					id, created_by_user_id, title, status, repository_generation,
					repository_head, repository_archive_key, repository_archive_sha256,
					sent_commit_sha, created_at, updated_at
				) VALUES (?, ?, ?, 'draft', 0, NULL, NULL, NULL, NULL, ?, ?)`
			)
			.bind(
				command.envelopeId,
				command.createdByUserId,
				command.title,
				command.createdAt,
				command.createdAt
			);
		const auditEvent: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO audit_event (
					id, envelope_id, sequence, event_type, actor_type,
					actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
				) VALUES (?, ?, 1, 'envelope.created', ?, ?, ?, NULL, ?, ?, 3)`
			)
			.bind(
				command.auditEventId,
				command.envelopeId,
				command.actor.type,
				command.actor.id,
				JSON.stringify({ title: command.title }),
				command.auditEventHash,
				command.createdAt
			);
		const idempotency: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO idempotency_key (
					caller_id, idempotency_key, request_hash, envelope_id, created_at
				) VALUES (?, ?, ?, ?, ?)`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.envelopeId,
				command.createdAt
			);

		try {
			await this.#database.batch([envelope, auditEvent, idempotency]);
		} catch (error: unknown) {
			// A concurrent request can win after the initial lookup. Only suppress
			// the batch error when the durable idempotency record proves that race.
			try {
				const raced: CreateEnvelopeStoreResult | null = await this.#resolveIdempotency(command);
				if (raced !== null) return raced;
			} catch {
				// Preserve the batch failure as the most useful root cause.
			}
			throw error;
		}

		return { outcome: 'created', envelope: envelopeFromCommand(command) };
	}

	async listEnvelopes(query: EnvelopeListQuery): Promise<EnvelopeListPage> {
		if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIST_LIMIT) {
			throw new RangeError(`Envelope list limit must be between 1 and ${MAX_LIST_LIMIT}.`);
		}

		let cursor: CursorRow | null = null;
		if (query.cursor !== null) {
			cursor = await this.#database
				.prepare('SELECT id, created_at FROM envelope WHERE id = ? LIMIT 1')
				.bind(query.cursor)
				.first<CursorRow>();
			if (cursor === null) return { items: [], nextCursor: null };
		}

		const fetchLimit: number = query.limit + 1;
		const statement: D1PreparedStatement =
			cursor === null
				? this.#database
						.prepare(
							`SELECT * FROM envelope
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(fetchLimit)
				: this.#database
						.prepare(
							`SELECT * FROM envelope
							 WHERE (created_at < ? OR (created_at = ? AND id < ?))
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(cursor.created_at, cursor.created_at, cursor.id, fetchLimit);
		const result: D1Result<D1EnvelopeRow> = await statement.all<D1EnvelopeRow>();
		const hasNextPage: boolean = result.results.length > query.limit;
		const rows: D1EnvelopeRow[] = hasNextPage
			? result.results.slice(0, query.limit)
			: result.results;
		const items: Envelope[] = rows.map((row: D1EnvelopeRow): Envelope => d1EnvelopeFromRow(row));
		const lastItem: Envelope | undefined = items.at(-1);

		return {
			items,
			nextCursor: hasNextPage && lastItem !== undefined ? lastItem.id : null
		};
	}

	async prepareDraftRevision(
		key: DraftRevisionKey,
		expectedGeneration: number
	): Promise<DraftRevisionPreparation> {
		const existing: DraftRevisionPreparation | null = await this.#resolveDraftRevision(key);
		if (existing !== null) return existing;

		const envelope: Envelope | null = await this.#envelopes.findEnvelope(key.envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'draft') return { outcome: 'immutable' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}

		const auditHead: DraftAuditHead | null = await this.#readAuditHead(key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return { outcome: 'ready', envelope, auditHead };
	}

	async publishDraftRevision(
		command: PublishDraftRevisionCommand
	): Promise<PublishDraftRevisionResult> {
		if (command.resultingGeneration !== command.expectedGeneration + 1) {
			return { outcome: 'integrity_error' };
		}

		const existing: DraftRevisionPreparation | null = await this.#resolveDraftRevision(command);
		if (existing !== null) return publishResultFromPreparation(existing);

		try {
			await this.#database
				.prepare(
					`INSERT INTO draft_revision_command (
						envelope_id, actor_type, actor_id, idempotency_key,
						request_hash, expected_generation, resulting_generation, commit_sha,
						archive_key, archive_sha256, updated_at, audit_event_id, audit_sequence,
						previous_audit_hash, audit_event_hash, audit_payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					command.envelopeId,
					command.actorType,
					command.actorId,
					command.idempotencyKey,
					command.requestFingerprint,
					command.expectedGeneration,
					command.resultingGeneration,
					command.commitSha,
					command.archiveKey,
					command.archiveSha256,
					command.updatedAt,
					command.auditEventId,
					command.expectedAuditSequence + 1,
					command.previousAuditHash,
					command.auditEventHash,
					command.auditPayloadJson
				)
				.run();
			return { outcome: 'published', revision: revisionFromCommand(command) };
		} catch (error: unknown) {
			const raced: DraftRevisionPreparation | null = await this.#resolveDraftRevision(command);
			if (raced !== null) return publishResultFromPreparation(raced);

			const classified: PublishDraftRevisionResult | null =
				await this.#classifyPublishFailure(command);
			if (classified !== null) return classified;
			throw error;
		}
	}

	findEnvelope(envelopeId: string): Promise<Envelope | null> {
		return this.#envelopes.findEnvelope(envelopeId);
	}

	async readDetail(envelopeId: string): Promise<EnvelopeDetail | null> {
		const envelopeStatement: D1PreparedStatement = this.#database
			.prepare(D1_ENVELOPE_BY_ID_SQL)
			.bind(envelopeId);
		const recipientStatement: D1PreparedStatement = this.#database
			.prepare(D1_ENVELOPE_DETAIL_RECIPIENT_SQL)
			.bind(envelopeId);
		const readyStatement: D1PreparedStatement = this.#database
			.prepare(D1_ENVELOPE_DETAIL_READY_SQL)
			.bind(envelopeId);
		const fieldStatement: D1PreparedStatement = this.#database
			.prepare(D1_ENVELOPE_DETAIL_FIELD_SQL)
			.bind(envelopeId);

		const batched: D1Result<
			D1EnvelopeRow | DetailRecipientRow | DetailReadyAuditRow | DetailFieldRow
		>[] = await this.#database.batch<
			D1EnvelopeRow | DetailRecipientRow | DetailReadyAuditRow | DetailFieldRow
		>([envelopeStatement, recipientStatement, readyStatement, fieldStatement]);
		if (batched.length !== 4) {
			throw new Error('Envelope detail batch did not return four results.');
		}

		const envelopeRows: D1EnvelopeRow[] = detailBatchRows<D1EnvelopeRow>(batched[0]);
		const envelopeRow: D1EnvelopeRow | undefined = envelopeRows[0];
		if (envelopeRow === undefined) return null;
		const envelope: Envelope = d1EnvelopeFromRow(envelopeRow);

		const recipientRows: DetailRecipientRow[] = detailBatchRows<DetailRecipientRow>(batched[1]);
		const readyRows: DetailReadyAuditRow[] = detailBatchRows<DetailReadyAuditRow>(batched[2]);
		const fieldRows: DetailFieldRow[] = detailBatchRows<DetailFieldRow>(batched[3]);
		const readyAuditEventId: string | null =
			envelope.status === 'draft' ? null : (readyRows[0]?.id ?? null);

		return {
			envelope,
			recipients: recipientRows.map((row: DetailRecipientRow): PublicEnvelopeRecipient =>
				fromRecipientRow(row)
			),
			readyAuditEventId,
			fields: fieldRows.map((row: DetailFieldRow): PublicEnvelopeDetailField => fromFieldRow(row))
		};
	}

	compareAndSetDraftPointer(envelopeId: string, update: DraftPointerUpdate): Promise<boolean> {
		return this.#envelopes.compareAndSetDraftPointer(envelopeId, update);
	}

	transition(
		envelopeId: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean> {
		return this.#envelopes.transition(envelopeId, expected, next, at);
	}

	async listDraftRevisionLocators(
		envelopeId: string,
		options?: { limit?: number; cursor?: number }
	): Promise<readonly PersistedDraftRevisionLocator[]> {
		// The persistence service requests the public limit (max 100) plus one
		// extra row to detect truncation; cap one above that so the extra row
		// is never silently dropped back down to the public max.
		const limit = Math.max(1, Math.min(options?.limit ?? 50, 101));
		const cursor = options?.cursor;
		if (cursor !== undefined) {
			const result = await this.#database
				.prepare(
					`SELECT envelope_id, resulting_generation, commit_sha, archive_key,
					        archive_sha256, updated_at, actor_type, actor_id, audit_payload_json
					 FROM draft_revision_command
					 WHERE envelope_id = ? AND resulting_generation < ?
					 ORDER BY resulting_generation DESC
					 LIMIT ?`
				)
				.bind(envelopeId, cursor, limit)
				.all<DraftRevisionLocatorRow>();
			return result.results.map(fromDraftRevisionLocatorRow);
		}
		const result = await this.#database
			.prepare(
				`SELECT envelope_id, resulting_generation, commit_sha, archive_key,
				        archive_sha256, updated_at, actor_type, actor_id, audit_payload_json
				 FROM draft_revision_command
				 WHERE envelope_id = ?
				 ORDER BY resulting_generation DESC
				 LIMIT ?`
			)
			.bind(envelopeId, limit)
			.all<DraftRevisionLocatorRow>();
		return result.results.map(fromDraftRevisionLocatorRow);
	}

	async findDraftRevisionLocatorByGeneration(
		envelopeId: string,
		generation: number
	): Promise<PersistedDraftRevisionLocator | null> {
		const row = await this.#database
			.prepare(
				`SELECT envelope_id, resulting_generation, commit_sha, archive_key,
				        archive_sha256, updated_at, actor_type, actor_id, audit_payload_json
				 FROM draft_revision_command
				 WHERE envelope_id = ? AND resulting_generation = ?
				 LIMIT 1`
			)
			.bind(envelopeId, generation)
			.first<DraftRevisionLocatorRow>();
		return row ? fromDraftRevisionLocatorRow(row) : null;
	}

	async findDraftRevisionLocatorByCommit(
		envelopeId: string,
		commitSha: string
	): Promise<PersistedDraftRevisionLocator | null> {
		const row = await this.#database
			.prepare(
				`SELECT envelope_id, resulting_generation, commit_sha, archive_key,
				        archive_sha256, updated_at, actor_type, actor_id, audit_payload_json
				 FROM draft_revision_command
				 WHERE envelope_id = ? AND commit_sha = ?
				 LIMIT 1`
			)
			.bind(envelopeId, commitSha)
			.first<DraftRevisionLocatorRow>();
		return row ? fromDraftRevisionLocatorRow(row) : null;
	}

	async #resolveIdempotency(
		command: CreateEnvelopeCommand
	): Promise<CreateEnvelopeStoreResult | null> {
		const row: IdempotencyRow | null = await this.#database
			.prepare(
				`SELECT request_hash, envelope_id FROM idempotency_key
				 WHERE caller_id = ? AND idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.id, command.idempotencyKey)
			.first<IdempotencyRow>();
		if (row === null) return null;
		// The stored envelope, not the caller's freshly minted candidate ID,
		// identifies what a replay returns; only a different request is a conflict.
		if (row.request_hash !== command.requestFingerprint) {
			return { outcome: 'conflict' };
		}

		const envelope: Envelope | null = await this.#envelopes.findEnvelope(row.envelope_id);
		if (envelope === null) {
			throw new Error('Idempotency record references a missing envelope.');
		}
		return { outcome: 'replayed', envelope };
	}

	async #resolveDraftRevision(key: DraftRevisionKey): Promise<DraftRevisionPreparation | null> {
		const row: DraftRevisionCommandRow | null = await this.#database
			.prepare(
				`SELECT
					command.envelope_id, command.actor_type,
					command.actor_id, command.request_hash, command.resulting_generation,
					command.commit_sha, command.archive_key, command.archive_sha256,
					command.updated_at, command.audit_event_id, command.audit_sequence,
					command.previous_audit_hash, command.audit_event_hash,
					command.audit_payload_json,
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
				 FROM draft_revision_command command
				 LEFT JOIN audit_event evidence
					ON evidence.id = command.audit_event_id
				 WHERE command.actor_type = ?
					AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(key.actorType, key.actorId, key.idempotencyKey)
			.first<DraftRevisionCommandRow>();
		if (row === null) return null;
		if (row.envelope_id !== key.envelopeId || row.request_hash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!hasValidD1AuditEvidence(row)) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', revision: revisionFromD1Row(row) };
	}

	async #readAuditHead(envelopeId: string): Promise<DraftAuditHead | null> {
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

	async #classifyPublishFailure(
		command: PublishDraftRevisionCommand
	): Promise<PublishDraftRevisionResult | null> {
		const envelope: Envelope | null = await this.#envelopes.findEnvelope(command.envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'draft') return { outcome: 'immutable' };
		if (envelope.repositoryGeneration !== command.expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}

		const auditHead: DraftAuditHead | null = await this.#readAuditHead(command.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };
		if (
			auditHead.sequence !== command.expectedAuditSequence ||
			auditHead.eventHash !== command.previousAuditHash
		) {
			return { outcome: 'audit_conflict' };
		}

		const collision: { value: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS value
				 FROM audit_event
				 WHERE id = ?
				 UNION ALL
				 SELECT 1 AS value
				 FROM draft_revision_command
				 WHERE envelope_id = ? AND resulting_generation = ?
				 LIMIT 1`
			)
			.bind(command.auditEventId, command.envelopeId, command.resultingGeneration)
			.first<{ value: number }>();
		return collision === null ? null : { outcome: 'integrity_error' };
	}
}

function hasValidD1AuditEvidence(row: DraftRevisionCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_envelope_id === row.envelope_id &&
		row.evidence_sequence === row.audit_sequence &&
		row.evidence_event_type === 'draft.revision_created' &&
		row.evidence_actor_type === row.actor_type &&
		row.evidence_actor_id === row.actor_id &&
		row.evidence_payload_json === row.audit_payload_json &&
		row.evidence_previous_hash === row.previous_audit_hash &&
		row.evidence_event_hash === row.audit_event_hash &&
		row.evidence_occurred_at === row.updated_at
	);
}

function revisionFromD1Row(row: DraftRevisionCommandRow): PublishedDraftRevision {
	return {
		generation: row.resulting_generation,
		commitSha: row.commit_sha,
		archiveKey: row.archive_key,
		archiveSha256: row.archive_sha256,
		updatedAt: row.updated_at,
		auditEventId: row.audit_event_id
	};
}

function revisionFromCommand(command: PublishDraftRevisionCommand): PublishedDraftRevision {
	return {
		generation: command.resultingGeneration,
		commitSha: command.commitSha,
		archiveKey: command.archiveKey,
		archiveSha256: command.archiveSha256,
		updatedAt: command.updatedAt,
		auditEventId: command.auditEventId
	};
}

function publishResultFromPreparation(
	preparation: DraftRevisionPreparation
): PublishDraftRevisionResult {
	if (preparation.outcome === 'replayed') return preparation;
	if (preparation.outcome === 'idempotency_conflict') return preparation;
	if (preparation.outcome === 'not_found') return preparation;
	if (preparation.outcome === 'immutable') return preparation;
	if (preparation.outcome === 'generation_conflict') return preparation;
	return { outcome: 'integrity_error' };
}

function envelopeFromCommand(command: CreateEnvelopeCommand): Envelope {
	return {
		id: command.envelopeId,
		createdByUserId: command.createdByUserId,
		title: command.title,
		status: 'draft',
		repositoryGeneration: 0,
		repositoryHead: null,
		repositoryArchiveKey: null,
		repositoryArchiveSha256: null,
		sentCommitSha: null,
		fieldGeneration: 0,
		createdAt: command.createdAt,
		updatedAt: command.createdAt
	};
}

interface DetailRecipientRow {
	id: string;
	email: string;
	name: string;
	role: string;
	locale: string;
	routing_order: number;
	status: string;
}

interface DetailReadyAuditRow {
	id: string;
}

interface DetailFieldRow {
	id: string;
	recipient_id: string;
	document_id: string | null;
	document_path: string | null;
	field_type: string;
	required: number | boolean;
	position: number;
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}

function fromRecipientRow(row: DetailRecipientRow): PublicEnvelopeRecipient {
	const role: RecipientRole | null = recipientRoleFromRow(row.role);
	const locale: 'en' | 'ja' | null = row.locale === 'en' || row.locale === 'ja' ? row.locale : null;
	const status: RecipientStatus | null = recipientStatusFromRow(row.status);
	if (
		typeof row.id !== 'string' ||
		row.id.length === 0 ||
		typeof row.email !== 'string' ||
		typeof row.name !== 'string' ||
		role === null ||
		locale === null ||
		status === null ||
		!Number.isSafeInteger(row.routing_order) ||
		row.routing_order < 1
	) {
		throw new Error('Stored envelope recipient row is corrupted.');
	}
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		role,
		locale,
		routingOrder: row.routing_order,
		status
	};
}

function fromFieldRow(row: DetailFieldRow): PublicEnvelopeDetailField {
	const fieldType: FieldType | null = fieldTypeFromRow(row.field_type);
	const documentId: string | null = typeof row.document_id === 'string' ? row.document_id : null;
	const documentPath: MarkdownPath | null =
		typeof row.document_path === 'string' ? (row.document_path as MarkdownPath) : null;
	const required: boolean | null =
		row.required === true || row.required === 1
			? true
			: row.required === false || row.required === 0
				? false
				: null;
	if (
		typeof row.id !== 'string' ||
		row.id.length === 0 ||
		typeof row.recipient_id !== 'string' ||
		row.recipient_id.length === 0 ||
		fieldType === null ||
		required === null ||
		(documentId === null) === (documentPath === null) ||
		!Number.isSafeInteger(row.position) ||
		row.position < 0
	) {
		throw new Error('Stored envelope field row is corrupted.');
	}
	return {
		id: row.id,
		recipientId: row.recipient_id,
		documentId,
		documentPath,
		fieldType,
		required,
		position: row.position,
		geometry: geometryFromColumns(row.page, row.x, row.y, row.width, row.height)
	};
}

function detailBatchRows<T>(result: D1Result<unknown> | undefined): T[] {
	if (result === undefined || !Array.isArray(result.results)) {
		throw new Error('Envelope detail batch result is malformed.');
	}
	return result.results as T[];
}

function recipientRoleFromRow(value: string): RecipientRole | null {
	for (const role of recipientRoles) {
		if (role === value) return role;
	}
	return null;
}

function recipientStatusFromRow(value: string): RecipientStatus | null {
	if (value === 'pending' || value === 'viewed' || value === 'completed' || value === 'declined') {
		return value;
	}
	return null;
}

function fieldTypeFromRow(value: string): FieldType | null {
	for (const fieldType of fieldTypes) {
		if (fieldType === value) return fieldType;
	}
	return null;
}

function geometryFromColumns(
	page: number | null,
	x: number | null,
	y: number | null,
	width: number | null,
	height: number | null
): FieldGeometry | null {
	if (page === null || x === null || y === null || width === null || height === null) {
		return null;
	}
	return { page, x, y, width, height };
}

interface DraftRevisionLocatorRow {
	envelope_id: string;
	resulting_generation: number;
	commit_sha: string;
	archive_key: string;
	archive_sha256: string;
	updated_at: string;
	actor_type: string;
	actor_id: string;
	audit_payload_json: string;
}

function fromDraftRevisionLocatorRow(row: DraftRevisionLocatorRow): PersistedDraftRevisionLocator {
	return {
		envelopeId: row.envelope_id,
		generation: row.resulting_generation,
		commitSha: row.commit_sha,
		archiveKey: row.archive_key,
		archiveSha256: row.archive_sha256,
		updatedAt: row.updated_at,
		actorType: row.actor_type as 'user' | 'agent' | 'system',
		actorId: row.actor_id,
		auditPayloadJson: row.audit_payload_json
	};
}
