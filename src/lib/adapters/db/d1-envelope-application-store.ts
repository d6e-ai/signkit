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
import type { DraftPointerUpdate } from '$lib/ports/envelope-store';
import { D1EnvelopeStore } from './d1-envelope-store';

const MAX_LIST_LIMIT: number = 100;

interface EnvelopeRow {
	id: string;
	organization_id: string;
	title: string;
	status: EnvelopeStatus;
	repository_generation: number;
	repository_head: string | null;
	repository_archive_key: string | null;
	repository_archive_sha256: string | null;
	sent_commit_sha: string | null;
	created_at: string;
	updated_at: string;
}

interface IdempotencyRow {
	envelope_id: string;
	request_hash: string;
}

interface CursorRow {
	id: string;
	created_at: string;
}

interface DraftRevisionCommandRow {
	organization_id: string;
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

/**
 * D1 implementation of the application-level envelope store. Creation uses
 * D1's native batch transaction so the projection, envelope, audit event, and
 * idempotency record either all become visible or none of them do.
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

		const organization: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO organization (id, d6e_organization_id, name, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name`
			)
			.bind(
				command.organizationId,
				command.organizationId,
				command.organizationName,
				command.createdAt
			);
		const envelope: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO envelope (
					id, organization_id, title, status, repository_generation,
					repository_head, repository_archive_key, repository_archive_sha256,
					sent_commit_sha, created_at, updated_at
				) VALUES (
					?,
					(SELECT id FROM organization WHERE id = ? AND d6e_organization_id = ?),
					?, 'draft', 0, NULL, NULL, NULL, NULL, ?, ?
				)`
			)
			.bind(
				command.envelopeId,
				command.organizationId,
				command.organizationId,
				command.title,
				command.createdAt,
				command.createdAt
			);
		const auditEvent: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO audit_event (
					id, organization_id, envelope_id, sequence, event_type, actor_type,
					actor_id, payload_json, previous_hash, event_hash, occurred_at
				) VALUES (?, ?, ?, 1, 'envelope.created', ?, ?, ?, NULL, ?, ?)`
			)
			.bind(
				command.auditEventId,
				command.organizationId,
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
					organization_id, caller_id, idempotency_key, request_hash, envelope_id, created_at
				) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.organizationId,
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.envelopeId,
				command.createdAt
			);

		try {
			await this.#database.batch([organization, envelope, auditEvent, idempotency]);
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

	async listForOrganization(
		organizationId: string,
		query: EnvelopeListQuery
	): Promise<EnvelopeListPage> {
		if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIST_LIMIT) {
			throw new RangeError(`Envelope list limit must be between 1 and ${MAX_LIST_LIMIT}.`);
		}

		let cursor: CursorRow | null = null;
		if (query.cursor !== null) {
			cursor = await this.#database
				.prepare('SELECT id, created_at FROM envelope WHERE organization_id = ? AND id = ? LIMIT 1')
				.bind(organizationId, query.cursor)
				.first<CursorRow>();
			if (cursor === null) return { items: [], nextCursor: null };
		}

		const fetchLimit: number = query.limit + 1;
		const statement: D1PreparedStatement =
			cursor === null
				? this.#database
						.prepare(
							`SELECT * FROM envelope
							 WHERE organization_id = ?
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, fetchLimit)
				: this.#database
						.prepare(
							`SELECT * FROM envelope
							 WHERE organization_id = ?
							   AND (created_at < ? OR (created_at = ? AND id < ?))
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, cursor.created_at, cursor.created_at, cursor.id, fetchLimit);
		const result: D1Result<EnvelopeRow> = await statement.all<EnvelopeRow>();
		const hasNextPage: boolean = result.results.length > query.limit;
		const rows: EnvelopeRow[] = hasNextPage ? result.results.slice(0, query.limit) : result.results;
		const items: Envelope[] = rows.map((row: EnvelopeRow): Envelope => envelopeFromRow(row));
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

		const envelope: Envelope | null = await this.#envelopes.findForOrganization(
			key.organizationId,
			key.envelopeId
		);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'draft') return { outcome: 'immutable' };
		if (envelope.repositoryGeneration !== expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}

		const auditHead: DraftAuditHead | null = await this.#readAuditHead(
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

		const existing: DraftRevisionPreparation | null = await this.#resolveDraftRevision(command);
		if (existing !== null) return publishResultFromPreparation(existing);

		try {
			await this.#database
				.prepare(
					`INSERT INTO draft_revision_command (
						organization_id, envelope_id, actor_type, actor_id, idempotency_key,
						request_hash, expected_generation, resulting_generation, commit_sha,
						archive_key, archive_sha256, updated_at, audit_event_id, audit_sequence,
						previous_audit_hash, audit_event_hash, audit_payload_json
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

	findForOrganization(organizationId: string, envelopeId: string): Promise<Envelope | null> {
		return this.#envelopes.findForOrganization(organizationId, envelopeId);
	}

	compareAndSetDraftPointer(
		organizationId: string,
		envelopeId: string,
		update: DraftPointerUpdate
	): Promise<boolean> {
		return this.#envelopes.compareAndSetDraftPointer(organizationId, envelopeId, update);
	}

	transition(
		organizationId: string,
		envelopeId: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean> {
		return this.#envelopes.transition(organizationId, envelopeId, expected, next, at);
	}

	async #resolveIdempotency(
		command: CreateEnvelopeCommand
	): Promise<CreateEnvelopeStoreResult | null> {
		const row: IdempotencyRow | null = await this.#database
			.prepare(
				`SELECT request_hash, envelope_id FROM idempotency_key
				 WHERE organization_id = ? AND caller_id = ? AND idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.organizationId, command.actor.id, command.idempotencyKey)
			.first<IdempotencyRow>();
		if (row === null) return null;
		if (row.request_hash !== command.requestFingerprint || row.envelope_id !== command.envelopeId) {
			return { outcome: 'conflict' };
		}

		const envelope: Envelope | null = await this.#envelopes.findForOrganization(
			command.organizationId,
			row.envelope_id
		);
		if (envelope === null) {
			throw new Error('Idempotency record references a missing organization-scoped envelope.');
		}
		return { outcome: 'replayed', envelope };
	}

	async #resolveDraftRevision(key: DraftRevisionKey): Promise<DraftRevisionPreparation | null> {
		const row: DraftRevisionCommandRow | null = await this.#database
			.prepare(
				`SELECT
					command.organization_id, command.envelope_id, command.actor_type,
					command.actor_id, command.request_hash, command.resulting_generation,
					command.commit_sha, command.archive_key, command.archive_sha256,
					command.updated_at, command.audit_event_id, command.audit_sequence,
					command.previous_audit_hash, command.audit_event_hash,
					command.audit_payload_json,
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
				 FROM draft_revision_command command
				 LEFT JOIN audit_event evidence
					ON evidence.organization_id = command.organization_id
					AND evidence.id = command.audit_event_id
				 WHERE command.organization_id = ? AND command.actor_type = ?
					AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(key.organizationId, key.actorType, key.actorId, key.idempotencyKey)
			.first<DraftRevisionCommandRow>();
		if (row === null) return null;
		if (row.envelope_id !== key.envelopeId || row.request_hash !== key.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		if (!hasValidD1AuditEvidence(row)) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', revision: revisionFromD1Row(row) };
	}

	async #readAuditHead(organizationId: string, envelopeId: string): Promise<DraftAuditHead | null> {
		const row: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash
				 FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ?
				 ORDER BY sequence DESC
				 LIMIT 1`
			)
			.bind(organizationId, envelopeId)
			.first<AuditHeadRow>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #classifyPublishFailure(
		command: PublishDraftRevisionCommand
	): Promise<PublishDraftRevisionResult | null> {
		const envelope: Envelope | null = await this.#envelopes.findForOrganization(
			command.organizationId,
			command.envelopeId
		);
		if (envelope === null) return { outcome: 'not_found' };
		if (envelope.status !== 'draft') return { outcome: 'immutable' };
		if (envelope.repositoryGeneration !== command.expectedGeneration) {
			return { outcome: 'generation_conflict' };
		}

		const auditHead: DraftAuditHead | null = await this.#readAuditHead(
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

		const collision: { value: number } | null = await this.#database
			.prepare(
				`SELECT 1 AS value
				 FROM audit_event
				 WHERE organization_id = ? AND id = ?
				 UNION ALL
				 SELECT 1 AS value
				 FROM draft_revision_command
				 WHERE organization_id = ? AND envelope_id = ? AND resulting_generation = ?
				 LIMIT 1`
			)
			.bind(
				command.organizationId,
				command.auditEventId,
				command.organizationId,
				command.envelopeId,
				command.resultingGeneration
			)
			.first<{ value: number }>();
		return collision === null ? null : { outcome: 'integrity_error' };
	}
}

function hasValidD1AuditEvidence(row: DraftRevisionCommandRow): boolean {
	return (
		row.evidence_event_id === row.audit_event_id &&
		row.evidence_organization_id === row.organization_id &&
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
		organizationId: command.organizationId,
		title: command.title,
		status: 'draft',
		repositoryGeneration: 0,
		repositoryHead: null,
		repositoryArchiveKey: null,
		repositoryArchiveSha256: null,
		sentCommitSha: null,
		createdAt: command.createdAt,
		updatedAt: command.createdAt
	};
}

function envelopeFromRow(row: EnvelopeRow): Envelope {
	return {
		id: row.id,
		organizationId: row.organization_id,
		title: row.title,
		status: row.status,
		repositoryGeneration: row.repository_generation,
		repositoryHead: row.repository_head,
		repositoryArchiveKey: row.repository_archive_key,
		repositoryArchiveSha256: row.repository_archive_sha256,
		sentCommitSha: row.sent_commit_sha,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
