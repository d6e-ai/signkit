import postgres from 'postgres';
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
import type {
	Envelope,
	EnvelopeStatus,
	FieldGeometry,
	FieldType,
	MarkdownPath,
	RecipientRole,
	RecipientStatus
} from '$lib/domain/envelope';
import type {
	DraftAuditHead,
	DraftMutationStore,
	DraftRevisionKey,
	DraftRevisionPreparation,
	PublishDraftRevisionCommand,
	PublishDraftRevisionResult,
	PublishedDraftRevision
} from '$lib/ports/draft-mutation-store';
import { PostgresEnvelopeStore } from './postgres-envelope-store';

const MAX_LIST_LIMIT = 100;

/** A pooled connection or an open transaction; both accept the same queries. */
type TransactionalSql = postgres.Sql | postgres.TransactionSql;

/**
 * Signals that another request committed this idempotency key first. It aborts
 * the candidate transaction so the record can be re-read after that commit.
 */
class ConcurrentEnvelopeCreationError extends Error {
	constructor() {
		super('Envelope creation lost an idempotency-key race');
		this.name = 'ConcurrentEnvelopeCreationError';
	}
}

interface EnvelopeRow {
	id: string;
	createdByUserId: string;
	title: string;
	status: EnvelopeStatus;
	repositoryGeneration: number;
	repositoryHead: string | null;
	repositoryArchiveKey: string | null;
	repositoryArchiveSha256: string | null;
	sentCommitSha: string | null;
	fieldGeneration: number;
	createdAt: Date | string;
	updatedAt: Date | string;
}

interface IdempotencyRow {
	requestHash: string;
	envelopeId: string;
}

interface DraftRevisionCommandRow {
	envelopeId: string;
	actorType: string;
	actorId: string;
	requestHash: string;
	resultingGeneration: number;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
	updatedAt: Date | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
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

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

/**
 * PostgreSQL collection adapter. Per-envelope operations are inherited from
 * PostgresEnvelopeStore; creation adds the creator projection,
 * idempotency record, envelope, and first audit event in one transaction.
 */
export class PostgresEnvelopeApplicationStore
	extends PostgresEnvelopeStore
	implements EnvelopeApplicationStore, DraftMutationStore
{
	private readonly applicationSql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		super(sql);
		this.applicationSql = sql;
	}

	async createIdempotently(command: CreateEnvelopeCommand): Promise<CreateEnvelopeStoreResult> {
		try {
			return await this.#createIdempotently(command);
		} catch (error: unknown) {
			if (!(error instanceof ConcurrentEnvelopeCreationError)) throw error;
			// A duplicate key committed while this transaction held its own
			// candidate envelope ID. The durable record is now visible and decides
			// between a safe replay and a genuine conflict.
			const raced: CreateEnvelopeStoreResult | null = await this.#resolveIdempotency(command);
			if (raced === null) throw error;
			return raced;
		}
	}

	async #createIdempotently(command: CreateEnvelopeCommand): Promise<CreateEnvelopeStoreResult> {
		return this.applicationSql.begin(async (transaction): Promise<CreateEnvelopeStoreResult> => {
			const replay: CreateEnvelopeStoreResult | null = await resolveIdempotency(
				transaction,
				command
			);
			if (replay !== null) return replay;

			const createdRows = await transaction<EnvelopeRow[]>`
				INSERT INTO envelope (
					id,
					created_by_user_id,
					title,
					status,
					repository_generation,
					created_at,
					updated_at
				)
				VALUES (
					${command.envelopeId},
					${command.createdByUserId},
					${command.title},
					'draft',
					0,
					${command.createdAt},
					${command.createdAt}
				)
				ON CONFLICT (id) DO NOTHING
				RETURNING
					id,
					created_by_user_id AS "createdByUserId",
					title,
					status,
					repository_generation AS "repositoryGeneration",
					repository_head AS "repositoryHead",
					repository_archive_key AS "repositoryArchiveKey",
					repository_archive_sha256 AS "repositoryArchiveSha256",
					sent_commit_sha AS "sentCommitSha",
					field_generation AS "fieldGeneration",
					created_at AS "createdAt",
					updated_at AS "updatedAt"
			`;

			if (createdRows.length !== 1) {
				// The candidate identifier is freshly minted, so a collision here is
				// not a replay.
				throw new Error('Envelope identifier collided with an existing envelope');
			}

			const idempotencyRows = await transaction<IdempotencyRow[]>`
				INSERT INTO idempotency_key (
					caller_id,
					idempotency_key,
					request_hash,
					envelope_id,
					created_at
				)
				VALUES (
					${command.actor.id},
					${command.idempotencyKey},
					${command.requestFingerprint},
					${command.envelopeId},
					${command.createdAt}
				)
				ON CONFLICT (caller_id, idempotency_key) DO NOTHING
				RETURNING request_hash AS "requestHash", envelope_id AS "envelopeId"
			`;
			if (idempotencyRows.length !== 1) {
				// A concurrent request committed the same key first. Roll this
				// candidate envelope back and resolve the outcome from its record.
				throw new ConcurrentEnvelopeCreationError();
			}

			await transaction`
				INSERT INTO audit_event (
					id,
					envelope_id,
					sequence,
					event_type,
					actor_type,
					actor_id,
					payload_json,
					previous_hash,
					event_hash,
					occurred_at
				)
				VALUES (
					${command.auditEventId},
					${command.envelopeId},
					1,
					'envelope.created',
					${command.actor.type},
					${command.actor.id},
					${JSON.stringify({ title: command.title })},
					NULL,
					${command.auditEventHash},
					${command.createdAt}
				)
			`;

			return { outcome: 'created', envelope: fromRow(createdRows[0]) };
		});
	}

	async #resolveIdempotency(
		command: CreateEnvelopeCommand
	): Promise<CreateEnvelopeStoreResult | null> {
		return resolveIdempotency(this.applicationSql, command);
	}

	async listEnvelopes(query: EnvelopeListQuery): Promise<EnvelopeListPage> {
		assertListLimit(query.limit);
		const rows = await this.applicationSql<EnvelopeRow[]>`
			SELECT
				e.id,
				e.created_by_user_id AS "createdByUserId",
				e.title,
				e.status,
				e.repository_generation AS "repositoryGeneration",
				e.repository_head AS "repositoryHead",
				e.repository_archive_key AS "repositoryArchiveKey",
				e.repository_archive_sha256 AS "repositoryArchiveSha256",
				e.sent_commit_sha AS "sentCommitSha",
				e.field_generation AS "fieldGeneration",
				e.created_at AS "createdAt",
				e.updated_at AS "updatedAt"
			FROM envelope e
			WHERE (
					${query.cursor}::text IS NULL
					OR (e.created_at, e.id) < (
						SELECT cursor_envelope.created_at, cursor_envelope.id
						FROM envelope cursor_envelope
						WHERE cursor_envelope.id = ${query.cursor}
					)
				)
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT ${query.limit + 1}
		`;
		const hasNextPage = rows.length > query.limit;
		const items = rows.slice(0, query.limit).map(fromRow);
		return {
			items,
			nextCursor: hasNextPage ? (items.at(-1)?.id ?? null) : null
		};
	}

	async readDetail(envelopeId: string): Promise<EnvelopeDetail | null> {
		const envelope: Envelope | null = await this.findEnvelope(envelopeId);
		if (envelope === null) return null;

		const recipientRows = await this.applicationSql<PostgresDetailRecipientRow[]>`
			SELECT
				id,
				email,
				name,
				role,
				locale,
				routing_order AS "routingOrder",
				status
			FROM recipient
			WHERE envelope_id = ${envelopeId}
			ORDER BY routing_order ASC, id ASC
		`;

		let readyAuditEventId: string | null = null;
		if (envelope.status !== 'draft') {
			const readyRows = await this.applicationSql<{ id: string }[]>`
				SELECT id
				FROM audit_event
				WHERE envelope_id = ${envelopeId}
					AND event_type = 'envelope.ready'
				ORDER BY sequence DESC
				LIMIT 1
			`;
			readyAuditEventId = readyRows[0]?.id ?? null;
		}

		const fieldRows = await this.applicationSql<PostgresDetailFieldRow[]>`
			SELECT
				id,
				recipient_id AS "recipientId",
				document_id AS "documentId",
				document_path AS "documentPath",
				field_type AS "fieldType",
				required,
				position,
				page,
				x,
				y,
				width,
				height
			FROM envelope_field
			WHERE envelope_id = ${envelopeId}
			ORDER BY COALESCE(document_id, document_path) ASC, position ASC, id ASC
		`;

		return {
			envelope,
			recipients: recipientRows.map(fromPostgresRecipientRow),
			readyAuditEventId,
			fields: fieldRows.map(fromPostgresFieldRow)
		};
	}

	async prepareDraftRevision(
		key: DraftRevisionKey,
		expectedGeneration: number
	): Promise<DraftRevisionPreparation> {
		const existingRows = await this.applicationSql<DraftRevisionCommandRow[]>`
			SELECT
				command.envelope_id AS "envelopeId",
				command.actor_type AS "actorType",
				command.actor_id AS "actorId",
				command.request_hash AS "requestHash",
				command.resulting_generation AS "resultingGeneration",
				command.commit_sha AS "commitSha",
				command.archive_key AS "archiveKey",
				command.archive_sha256 AS "archiveSha256",
				command.updated_at AS "updatedAt",
				command.audit_event_id AS "auditEventId",
				command.audit_sequence AS "auditSequence",
				command.previous_audit_hash AS "previousAuditHash",
				command.audit_event_hash AS "auditEventHash",
				command.audit_payload_json AS "auditPayloadJson",
				evidence.id AS "evidenceEventId",
				evidence.envelope_id AS "evidenceEnvelopeId",
				evidence.sequence AS "evidenceSequence",
				evidence.event_type AS "evidenceEventType",
				evidence.actor_type AS "evidenceActorType",
				evidence.actor_id AS "evidenceActorId",
				evidence.payload_json AS "evidencePayloadJson",
				evidence.previous_hash AS "evidencePreviousHash",
				evidence.event_hash AS "evidenceEventHash",
				evidence.occurred_at AS "evidenceOccurredAt"
			FROM draft_revision_command command
			LEFT JOIN audit_event evidence
				ON evidence.id = command.audit_event_id
			WHERE command.actor_type = ${key.actorType}
				AND command.actor_id = ${key.actorId}
				AND command.idempotency_key = ${key.idempotencyKey}
			LIMIT 1
		`;
		const existing: DraftRevisionPreparation | null = resolvePostgresDraftRevision(
			existingRows[0],
			key
		);
		if (existing !== null) return existing;

		const envelope: Envelope | null = await this.findEnvelope(key.envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'draft') return { outcome: 'immutable' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}

		const auditHead: DraftAuditHead | null = await this.#readAuditHead(
			this.applicationSql,
			key.envelopeId
		);
		if (auditHead === null) return { outcome: 'integrity_error' };
		return { outcome: 'ready', envelope, auditHead };
	}

	async publishDraftRevision(
		command: PublishDraftRevisionCommand
	): Promise<PublishDraftRevisionResult> {
		if (command.resultingGeneration !== command.expectedGeneration + 1) {
			return { outcome: 'integrity_error' };
		}

		try {
			return await this.applicationSql.begin(
				async (transaction): Promise<PublishDraftRevisionResult> => {
					const initialCommandRows = await transaction<DraftRevisionCommandRow[]>`
					SELECT
						command.envelope_id AS "envelopeId",
						command.actor_type AS "actorType",
						command.actor_id AS "actorId",
						command.request_hash AS "requestHash",
						command.resulting_generation AS "resultingGeneration",
						command.commit_sha AS "commitSha",
						command.archive_key AS "archiveKey",
						command.archive_sha256 AS "archiveSha256",
						command.updated_at AS "updatedAt",
						command.audit_event_id AS "auditEventId",
						command.audit_sequence AS "auditSequence",
						command.previous_audit_hash AS "previousAuditHash",
						command.audit_event_hash AS "auditEventHash",
						command.audit_payload_json AS "auditPayloadJson",
						evidence.id AS "evidenceEventId",
						evidence.envelope_id AS "evidenceEnvelopeId",
						evidence.sequence AS "evidenceSequence",
						evidence.event_type AS "evidenceEventType",
						evidence.actor_type AS "evidenceActorType",
						evidence.actor_id AS "evidenceActorId",
						evidence.payload_json AS "evidencePayloadJson",
						evidence.previous_hash AS "evidencePreviousHash",
						evidence.event_hash AS "evidenceEventHash",
						evidence.occurred_at AS "evidenceOccurredAt"
					FROM draft_revision_command command
					LEFT JOIN audit_event evidence
						ON evidence.id = command.audit_event_id
					WHERE command.actor_type = ${command.actorType}
						AND command.actor_id = ${command.actorId}
						AND command.idempotency_key = ${command.idempotencyKey}
					LIMIT 1
				`;
					const initial: DraftRevisionPreparation | null = resolvePostgresDraftRevision(
						initialCommandRows[0],
						command
					);
					if (initial !== null) return publishResultFromPreparation(initial);

					const envelopeRows = await transaction<EnvelopeRow[]>`
					SELECT
						id,
						title,
						status,
						repository_generation AS "repositoryGeneration",
						repository_head AS "repositoryHead",
						repository_archive_key AS "repositoryArchiveKey",
						repository_archive_sha256 AS "repositoryArchiveSha256",
						sent_commit_sha AS "sentCommitSha",
						field_generation AS "fieldGeneration",
						created_at AS "createdAt",
						updated_at AS "updatedAt"
					FROM envelope
					WHERE id = ${command.envelopeId}
					FOR UPDATE
				`;
					const envelopeRow: EnvelopeRow | undefined = envelopeRows[0];
					if (envelopeRow === undefined) return { outcome: 'not_found' };

					// The row lock serializes different keys. Recheck the key because a
					// duplicate request may have committed while this transaction waited.
					const racedCommandRows = await transaction<DraftRevisionCommandRow[]>`
					SELECT
						command.envelope_id AS "envelopeId",
						command.actor_type AS "actorType",
						command.actor_id AS "actorId",
						command.request_hash AS "requestHash",
						command.resulting_generation AS "resultingGeneration",
						command.commit_sha AS "commitSha",
						command.archive_key AS "archiveKey",
						command.archive_sha256 AS "archiveSha256",
						command.updated_at AS "updatedAt",
						command.audit_event_id AS "auditEventId",
						command.audit_sequence AS "auditSequence",
						command.previous_audit_hash AS "previousAuditHash",
						command.audit_event_hash AS "auditEventHash",
						command.audit_payload_json AS "auditPayloadJson",
						evidence.id AS "evidenceEventId",
						evidence.envelope_id AS "evidenceEnvelopeId",
						evidence.sequence AS "evidenceSequence",
						evidence.event_type AS "evidenceEventType",
						evidence.actor_type AS "evidenceActorType",
						evidence.actor_id AS "evidenceActorId",
						evidence.payload_json AS "evidencePayloadJson",
						evidence.previous_hash AS "evidencePreviousHash",
						evidence.event_hash AS "evidenceEventHash",
						evidence.occurred_at AS "evidenceOccurredAt"
					FROM draft_revision_command command
					LEFT JOIN audit_event evidence
						ON evidence.id = command.audit_event_id
					WHERE command.actor_type = ${command.actorType}
						AND command.actor_id = ${command.actorId}
						AND command.idempotency_key = ${command.idempotencyKey}
					LIMIT 1
				`;
					const raced: DraftRevisionPreparation | null = resolvePostgresDraftRevision(
						racedCommandRows[0],
						command
					);
					if (raced !== null) return publishResultFromPreparation(raced);

					const envelope: Envelope = fromRow(envelopeRow);
					if (envelope.status !== 'draft') return { outcome: 'immutable' };
					if (envelope.repositoryGeneration !== command.expectedGeneration) {
						return { outcome: 'generation_conflict' };
					}

					const auditHeadRows = await transaction<AuditHeadRow[]>`
					SELECT sequence, event_hash AS "eventHash"
					FROM audit_event
					WHERE envelope_id = ${command.envelopeId}
					ORDER BY sequence DESC
					LIMIT 1
				`;
					const auditHead: DraftAuditHead | null = auditHeadFromPostgresRow(auditHeadRows[0]);
					if (auditHead === null) return { outcome: 'integrity_error' };
					if (
						auditHead.sequence !== command.expectedAuditSequence ||
						auditHead.eventHash !== command.previousAuditHash
					) {
						return { outcome: 'audit_conflict' };
					}

					const updatedRows = await transaction<{ id: string }[]>`
					UPDATE envelope
					SET repository_generation = ${command.resultingGeneration},
						repository_head = ${command.commitSha},
						repository_archive_key = ${command.archiveKey},
						repository_archive_sha256 = ${command.archiveSha256},
						updated_at = ${command.updatedAt}
					WHERE id = ${command.envelopeId}
						AND status = 'draft'
						AND repository_generation = ${command.expectedGeneration}
					RETURNING id
				`;
					if (updatedRows.length !== 1) return { outcome: 'generation_conflict' };

					await transaction`
					INSERT INTO draft_revision_command (
						envelope_id, actor_type, actor_id, idempotency_key,
						request_hash, expected_generation, resulting_generation, commit_sha,
						archive_key, archive_sha256, updated_at, audit_event_id, audit_sequence,
						previous_audit_hash, audit_event_hash, audit_payload_json
					) VALUES (
						${command.envelopeId}, ${command.actorType},
						${command.actorId}, ${command.idempotencyKey}, ${command.requestFingerprint},
						${command.expectedGeneration}, ${command.resultingGeneration},
						${command.commitSha}, ${command.archiveKey}, ${command.archiveSha256},
						${command.updatedAt}, ${command.auditEventId},
						${command.expectedAuditSequence + 1}, ${command.previousAuditHash},
						${command.auditEventHash}, ${command.auditPayloadJson}
					)
				`;

					await transaction`
					INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type,
						actor_id, payload_json, previous_hash, event_hash, occurred_at
					) VALUES (
						${command.auditEventId}, ${command.envelopeId},
						${command.expectedAuditSequence + 1}, 'draft.revision_created',
						${command.actorType}, ${command.actorId}, ${command.auditPayloadJson},
						${command.previousAuditHash}, ${command.auditEventHash}, ${command.updatedAt}
					)
				`;

					return { outcome: 'published', revision: revisionFromCommand(command) };
				}
			);
		} catch (error: unknown) {
			// A uniqueness failure can be a concurrent duplicate or a key reused
			// against another envelope. Classify by durable state, never by provider
			// error text or PostgreSQL-specific error codes.
			const preparation: DraftRevisionPreparation = await this.prepareDraftRevision(
				command,
				command.expectedGeneration
			);
			if (preparation.outcome === 'replayed') return preparation;
			if (preparation.outcome === 'idempotency_conflict') return preparation;
			if (preparation.outcome === 'not_found') return preparation;
			if (preparation.outcome === 'immutable') return preparation;
			if (preparation.outcome === 'generation_conflict') return preparation;
			if (preparation.outcome === 'integrity_error') return preparation;
			if (
				preparation.auditHead.sequence !== command.expectedAuditSequence ||
				preparation.auditHead.eventHash !== command.previousAuditHash
			) {
				return { outcome: 'audit_conflict' };
			}
			throw error;
		}
	}

	async #readAuditHead(
		sql: ReturnType<typeof postgres>,
		envelopeId: string
	): Promise<DraftAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash"
			FROM audit_event
			WHERE envelope_id = ${envelopeId}
			ORDER BY sequence DESC
			LIMIT 1
		`;
		return auditHeadFromPostgresRow(rows[0]);
	}
}

/**
 * Reads the durable idempotency record. The stored `envelope_id`, never the
 * caller's freshly minted candidate, identifies the envelope a replay returns;
 * only a different request fingerprint is a conflict.
 */
async function resolveIdempotency(
	sql: TransactionalSql,
	command: CreateEnvelopeCommand
): Promise<CreateEnvelopeStoreResult | null> {
	const idempotencyRows = await sql<IdempotencyRow[]>`
		SELECT
			request_hash AS "requestHash",
			envelope_id AS "envelopeId"
		FROM idempotency_key
		WHERE caller_id = ${command.actor.id}
			AND idempotency_key = ${command.idempotencyKey}
		LIMIT 1
	`;
	const idempotency: IdempotencyRow | undefined = idempotencyRows[0];
	if (idempotency === undefined) return null;
	if (idempotency.requestHash !== command.requestFingerprint) return { outcome: 'conflict' };

	const replayRows = await sql<EnvelopeRow[]>`
		SELECT
			id,
			title,
			status,
			repository_generation AS "repositoryGeneration",
			repository_head AS "repositoryHead",
			repository_archive_key AS "repositoryArchiveKey",
			repository_archive_sha256 AS "repositoryArchiveSha256",
			sent_commit_sha AS "sentCommitSha",
			field_generation AS "fieldGeneration",
			created_at AS "createdAt",
			updated_at AS "updatedAt"
		FROM envelope
		WHERE id = ${idempotency.envelopeId}
		LIMIT 1
	`;
	if (replayRows.length !== 1) {
		throw new Error('Idempotency record references a missing envelope');
	}

	return { outcome: 'replayed', envelope: fromRow(replayRows[0]) };
}

function resolvePostgresDraftRevision(
	row: DraftRevisionCommandRow | undefined,
	key: DraftRevisionKey
): DraftRevisionPreparation | null {
	if (row === undefined) return null;
	if (row.envelopeId !== key.envelopeId || row.requestHash !== key.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (!hasValidPostgresAuditEvidence(row)) return { outcome: 'integrity_error' };
	return { outcome: 'replayed', revision: revisionFromPostgresRow(row) };
}

function hasValidPostgresAuditEvidence(row: DraftRevisionCommandRow): boolean {
	const auditSequence: number = numericSequence(row.auditSequence);
	const evidenceSequence: number = numericSequence(row.evidenceSequence);
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number.isSafeInteger(auditSequence) &&
		evidenceSequence === auditSequence &&
		row.evidenceEventType === 'draft.revision_created' &&
		row.evidenceActorType === row.actorType &&
		row.evidenceActorId === row.actorId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, row.updatedAt)
	);
}

function numericSequence(value: number | string | null): number {
	return typeof value === 'number' ? value : value === null ? Number.NaN : Number(value);
}

function sameTimestamp(left: Date | string | null, right: Date | string): boolean {
	if (left === null) return false;
	try {
		return timestamp(left) === timestamp(right);
	} catch {
		return false;
	}
}

function revisionFromPostgresRow(row: DraftRevisionCommandRow): PublishedDraftRevision {
	return {
		generation: row.resultingGeneration,
		commitSha: row.commitSha,
		archiveKey: row.archiveKey,
		archiveSha256: row.archiveSha256,
		updatedAt: timestamp(row.updatedAt),
		auditEventId: row.auditEventId
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

function auditHeadFromPostgresRow(row: AuditHeadRow | undefined): DraftAuditHead | null {
	if (row === undefined) return null;
	const sequence: number = typeof row.sequence === 'number' ? row.sequence : Number(row.sequence);
	if (!Number.isSafeInteger(sequence) || sequence < 1 || row.eventHash.length === 0) return null;
	return { sequence, eventHash: row.eventHash };
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

function fromRow(row: EnvelopeRow): Envelope {
	return {
		id: row.id,
		createdByUserId: row.createdByUserId,
		title: row.title,
		status: row.status,
		repositoryGeneration: row.repositoryGeneration,
		repositoryHead: row.repositoryHead,
		repositoryArchiveKey: row.repositoryArchiveKey,
		repositoryArchiveSha256: row.repositoryArchiveSha256,
		sentCommitSha: row.sentCommitSha,
		fieldGeneration: row.fieldGeneration,
		createdAt: timestamp(row.createdAt),
		updatedAt: timestamp(row.updatedAt)
	};
}

function timestamp(value: Date | string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error('PostgreSQL returned an invalid timestamp');
	return date.toISOString();
}

function assertListLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
		throw new Error(`Envelope list limit must be between 1 and ${MAX_LIST_LIMIT}`);
	}
}

interface PostgresDetailRecipientRow {
	id: string;
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
	status: RecipientStatus;
}

interface PostgresDetailFieldRow {
	id: string;
	recipientId: string;
	documentId: string | null;
	documentPath: MarkdownPath | null;
	fieldType: FieldType;
	required: boolean;
	position: number;
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}

function fromPostgresRecipientRow(row: PostgresDetailRecipientRow): PublicEnvelopeRecipient {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		role: row.role,
		locale: row.locale,
		routingOrder: row.routingOrder,
		status: row.status
	};
}

function fromPostgresFieldRow(row: PostgresDetailFieldRow): PublicEnvelopeDetailField {
	return {
		id: row.id,
		recipientId: row.recipientId,
		documentId: row.documentId,
		documentPath: row.documentPath,
		fieldType: row.fieldType,
		required: row.required,
		position: row.position,
		geometry: postgresGeometryFromColumns(row.page, row.x, row.y, row.width, row.height)
	};
}

function postgresGeometryFromColumns(
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
