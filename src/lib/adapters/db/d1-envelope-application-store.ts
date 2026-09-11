import type {
	CreateEnvelopeCommand,
	CreateEnvelopeStoreResult,
	EnvelopeApplicationStore,
	EnvelopeListPage,
	EnvelopeListQuery
} from '$lib/application/envelopes/model';
import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
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

/**
 * D1 implementation of the application-level envelope store. Creation uses
 * D1's native batch transaction so the projection, envelope, audit event, and
 * idempotency record either all become visible or none of them do.
 */
export class D1EnvelopeApplicationStore implements EnvelopeApplicationStore {
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
