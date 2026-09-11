import postgres from 'postgres';
import type {
	CreateEnvelopeCommand,
	CreateEnvelopeStoreResult,
	EnvelopeApplicationStore,
	EnvelopeListPage,
	EnvelopeListQuery
} from '$lib/application/envelopes/model';
import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
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

interface EnvelopeRow {
	id: string;
	organizationId: string;
	title: string;
	status: EnvelopeStatus;
	repositoryGeneration: number;
	repositoryHead: string | null;
	repositoryArchiveKey: string | null;
	repositoryArchiveSha256: string | null;
	sentCommitSha: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
}

interface IdempotencyRow {
	requestHash: string;
	envelopeId: string;
}

interface DraftRevisionCommandRow {
	organizationId: string;
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

/**
 * PostgreSQL collection adapter. Per-envelope operations are inherited from
 * PostgresEnvelopeStore; creation adds the organization projection,
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
		return this.applicationSql.begin(async (transaction): Promise<CreateEnvelopeStoreResult> => {
			const organizations = await transaction<{ id: string }[]>`
				INSERT INTO organization (id, d6e_organization_id, name, created_at)
				VALUES (
					${command.organizationId},
					${command.organizationId},
					${command.organizationName},
					${command.createdAt}
				)
				ON CONFLICT (id) DO UPDATE
				SET name = EXCLUDED.name
				WHERE organization.d6e_organization_id = EXCLUDED.d6e_organization_id
				RETURNING id
			`;
			if (organizations.length !== 1) {
				throw new Error('Organization projection conflicts with its d6e-auth identifier');
			}

			const createdRows = await transaction<EnvelopeRow[]>`
				INSERT INTO envelope (
					id,
					organization_id,
					title,
					status,
					repository_generation,
					created_at,
					updated_at
				)
				VALUES (
					${command.envelopeId},
					${command.organizationId},
					${command.title},
					'draft',
					0,
					${command.createdAt},
					${command.createdAt}
				)
				ON CONFLICT (organization_id, id) DO NOTHING
				RETURNING
					id,
					organization_id AS "organizationId",
					title,
					status,
					repository_generation AS "repositoryGeneration",
					repository_head AS "repositoryHead",
					repository_archive_key AS "repositoryArchiveKey",
					repository_archive_sha256 AS "repositoryArchiveSha256",
					sent_commit_sha AS "sentCommitSha",
					created_at AS "createdAt",
					updated_at AS "updatedAt"
			`;

			if (createdRows.length === 1) {
				const idempotencyRows = await transaction<IdempotencyRow[]>`
					INSERT INTO idempotency_key (
						organization_id,
						caller_id,
						idempotency_key,
						request_hash,
						envelope_id,
						created_at
					)
					VALUES (
						${command.organizationId},
						${command.actor.id},
						${command.idempotencyKey},
						${command.requestFingerprint},
						${command.envelopeId},
						${command.createdAt}
					)
					ON CONFLICT (organization_id, caller_id, idempotency_key) DO NOTHING
					RETURNING request_hash AS "requestHash", envelope_id AS "envelopeId"
				`;
				if (idempotencyRows.length !== 1) {
					throw new Error('Idempotency key maps to a different envelope');
				}

				await transaction`
					INSERT INTO audit_event (
						id,
						organization_id,
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
						${command.organizationId},
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
			}

			const idempotencyRows = await transaction<IdempotencyRow[]>`
				SELECT
					request_hash AS "requestHash",
					envelope_id AS "envelopeId"
				FROM idempotency_key
				WHERE organization_id = ${command.organizationId}
					AND caller_id = ${command.actor.id}
					AND idempotency_key = ${command.idempotencyKey}
				LIMIT 1
			`;
			const idempotency = idempotencyRows[0];
			if (
				!idempotency ||
				idempotency.requestHash !== command.requestFingerprint ||
				idempotency.envelopeId !== command.envelopeId
			) {
				return { outcome: 'conflict' };
			}

			const replayRows = await transaction<EnvelopeRow[]>`
				SELECT
					id,
					organization_id AS "organizationId",
					title,
					status,
					repository_generation AS "repositoryGeneration",
					repository_head AS "repositoryHead",
					repository_archive_key AS "repositoryArchiveKey",
					repository_archive_sha256 AS "repositoryArchiveSha256",
					sent_commit_sha AS "sentCommitSha",
					created_at AS "createdAt",
					updated_at AS "updatedAt"
				FROM envelope
				WHERE organization_id = ${command.organizationId}
					AND id = ${idempotency.envelopeId}
				LIMIT 1
			`;
			if (replayRows.length !== 1) {
				throw new Error('Idempotency record references a missing envelope');
			}

			return { outcome: 'replayed', envelope: fromRow(replayRows[0]) };
		});
	}

	async listForOrganization(
		organizationId: string,
		query: EnvelopeListQuery
	): Promise<EnvelopeListPage> {
		assertListLimit(query.limit);
		const rows = await this.applicationSql<EnvelopeRow[]>`
			SELECT
				e.id,
				e.organization_id AS "organizationId",
				e.title,
				e.status,
				e.repository_generation AS "repositoryGeneration",
				e.repository_head AS "repositoryHead",
				e.repository_archive_key AS "repositoryArchiveKey",
				e.repository_archive_sha256 AS "repositoryArchiveSha256",
				e.sent_commit_sha AS "sentCommitSha",
				e.created_at AS "createdAt",
				e.updated_at AS "updatedAt"
			FROM envelope e
			WHERE e.organization_id = ${organizationId}
				AND (
					${query.cursor}::text IS NULL
					OR (e.created_at, e.id) < (
						SELECT cursor_envelope.created_at, cursor_envelope.id
						FROM envelope cursor_envelope
						WHERE cursor_envelope.organization_id = ${organizationId}
							AND cursor_envelope.id = ${query.cursor}
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

	async prepareDraftRevision(
		key: DraftRevisionKey,
		expectedGeneration: number
	): Promise<DraftRevisionPreparation> {
		const existingRows = await this.applicationSql<DraftRevisionCommandRow[]>`
			SELECT
				command.organization_id AS "organizationId",
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
			FROM draft_revision_command command
			LEFT JOIN audit_event evidence
				ON evidence.organization_id = command.organization_id
				AND evidence.id = command.audit_event_id
			WHERE command.organization_id = ${key.organizationId}
				AND command.actor_type = ${key.actorType}
				AND command.actor_id = ${key.actorId}
				AND command.idempotency_key = ${key.idempotencyKey}
			LIMIT 1
		`;
		const existing: DraftRevisionPreparation | null = resolvePostgresDraftRevision(
			existingRows[0],
			key
		);
		if (existing !== null) return existing;

		const envelope: Envelope | null = await this.findForOrganization(
			key.organizationId,
			key.envelopeId
		);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'draft') return { outcome: 'immutable' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}

		const auditHead: DraftAuditHead | null = await this.#readAuditHead(
			this.applicationSql,
			key.organizationId,
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
						command.organization_id AS "organizationId",
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
					FROM draft_revision_command command
					LEFT JOIN audit_event evidence
						ON evidence.organization_id = command.organization_id
						AND evidence.id = command.audit_event_id
					WHERE command.organization_id = ${command.organizationId}
						AND command.actor_type = ${command.actorType}
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
						organization_id AS "organizationId",
						title,
						status,
						repository_generation AS "repositoryGeneration",
						repository_head AS "repositoryHead",
						repository_archive_key AS "repositoryArchiveKey",
						repository_archive_sha256 AS "repositoryArchiveSha256",
						sent_commit_sha AS "sentCommitSha",
						created_at AS "createdAt",
						updated_at AS "updatedAt"
					FROM envelope
					WHERE organization_id = ${command.organizationId} AND id = ${command.envelopeId}
					FOR UPDATE
				`;
					const envelopeRow: EnvelopeRow | undefined = envelopeRows[0];
					if (envelopeRow === undefined) return { outcome: 'not_found' };

					// The row lock serializes different keys. Recheck the key because a
					// duplicate request may have committed while this transaction waited.
					const racedCommandRows = await transaction<DraftRevisionCommandRow[]>`
					SELECT
						command.organization_id AS "organizationId",
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
					FROM draft_revision_command command
					LEFT JOIN audit_event evidence
						ON evidence.organization_id = command.organization_id
						AND evidence.id = command.audit_event_id
					WHERE command.organization_id = ${command.organizationId}
						AND command.actor_type = ${command.actorType}
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
					WHERE organization_id = ${command.organizationId}
						AND envelope_id = ${command.envelopeId}
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
					WHERE organization_id = ${command.organizationId}
						AND id = ${command.envelopeId}
						AND status = 'draft'
						AND repository_generation = ${command.expectedGeneration}
					RETURNING id
				`;
					if (updatedRows.length !== 1) return { outcome: 'generation_conflict' };

					await transaction`
					INSERT INTO draft_revision_command (
						organization_id, envelope_id, actor_type, actor_id, idempotency_key,
						request_hash, expected_generation, resulting_generation, commit_sha,
						archive_key, archive_sha256, updated_at, audit_event_id, audit_sequence,
						previous_audit_hash, audit_event_hash, audit_payload_json
					) VALUES (
						${command.organizationId}, ${command.envelopeId}, ${command.actorType},
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
						id, organization_id, envelope_id, sequence, event_type, actor_type,
						actor_id, payload_json, previous_hash, event_hash, occurred_at
					) VALUES (
						${command.auditEventId}, ${command.organizationId}, ${command.envelopeId},
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
		organizationId: string,
		envelopeId: string
	): Promise<DraftAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash"
			FROM audit_event
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY sequence DESC
			LIMIT 1
		`;
		return auditHeadFromPostgresRow(rows[0]);
	}
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
		row.evidenceOrganizationId === row.organizationId &&
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
		organizationId: row.organizationId,
		title: row.title,
		status: row.status,
		repositoryGeneration: row.repositoryGeneration,
		repositoryHead: row.repositoryHead,
		repositoryArchiveKey: row.repositoryArchiveKey,
		repositoryArchiveSha256: row.repositoryArchiveSha256,
		sentCommitSha: row.sentCommitSha,
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
