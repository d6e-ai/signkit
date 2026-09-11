import postgres from 'postgres';
import type {
	CreateEnvelopeCommand,
	CreateEnvelopeStoreResult,
	EnvelopeApplicationStore,
	EnvelopeListPage,
	EnvelopeListQuery
} from '$lib/application/envelopes/model';
import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
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

/**
 * PostgreSQL collection adapter. Per-envelope operations are inherited from
 * PostgresEnvelopeStore; creation adds the organization projection,
 * idempotency record, envelope, and first audit event in one transaction.
 */
export class PostgresEnvelopeApplicationStore
	extends PostgresEnvelopeStore
	implements EnvelopeApplicationStore
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
