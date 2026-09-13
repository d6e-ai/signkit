import postgres from 'postgres';
import type {
	DiscoverExpirableEnvelopesCommand,
	EnvelopeExpiryAuditHead,
	EnvelopeExpiryPreparation,
	EnvelopeExpiryStore,
	ExpirableEnvelopeId,
	ExpirableEnvelopeStatus,
	PublishEnvelopeExpiryCommand,
	PublishEnvelopeExpiryResult
} from '$lib/ports/envelope-expiry-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class EnvelopeExpiryIntegrityError extends Error {
	constructor() {
		super('Envelope expiry publication integrity check failed');
		this.name = 'EnvelopeExpiryIntegrityError';
	}
}

interface EnvelopeRow {
	status: string;
	repositoryGeneration: number;
	repositoryHead: string | null;
	sentCommitSha: string | null;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

export class PostgresEnvelopeExpiryStore implements EnvelopeExpiryStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async discoverExpirableEnvelopes(
		command: DiscoverExpirableEnvelopesCommand
	): Promise<readonly ExpirableEnvelopeId[]> {
		const rows = await this.#sql<{ organizationId: string; envelopeId: string }[]>`
			SELECT envelope.organization_id AS "organizationId", envelope.id AS "envelopeId"
			FROM envelope
			WHERE envelope.status IN ('sent', 'in_progress')
				AND EXISTS (
					SELECT 1 FROM recipient
					WHERE recipient.organization_id = envelope.organization_id
						AND recipient.envelope_id = envelope.id
						AND recipient.role IN ('signer', 'approver')
						AND recipient.status IN ('pending', 'viewed')
						AND recipient.capability_expires_at IS NOT NULL
						AND recipient.capability_expires_at <= ${command.now}::timestamptz
				)
				AND NOT EXISTS (
					SELECT 1 FROM recipient
					WHERE recipient.organization_id = envelope.organization_id
						AND recipient.envelope_id = envelope.id
						AND recipient.role IN ('signer', 'approver')
						AND recipient.status IN ('pending', 'viewed')
						AND recipient.capability_expires_at IS NOT NULL
						AND recipient.capability_expires_at > ${command.now}::timestamptz
				)
			ORDER BY envelope.updated_at ASC, envelope.id ASC
			LIMIT ${command.limit}`;
		return rows;
	}

	async prepareEnvelopeExpiry(
		organizationId: string,
		envelopeId: string,
		now: string
	): Promise<EnvelopeExpiryPreparation> {
		return await this.#prepare(this.#sql, organizationId, envelopeId, now, false);
	}

	async publishEnvelopeExpiry(
		command: PublishEnvelopeExpiryCommand
	): Promise<PublishEnvelopeExpiryResult> {
		try {
			return await this.#sql.begin(async (transaction): Promise<PublishEnvelopeExpiryResult> => {
				const preparation: EnvelopeExpiryPreparation = await this.#prepare(
					transaction,
					command.organizationId,
					command.envelopeId,
					command.expiredAt,
					true
				);
				if (preparation.outcome !== 'ready') return { outcome: preparation.outcome };
				if (
					preparation.previousStatus !== command.expectedStatus ||
					preparation.generation !== command.expectedGeneration ||
					preparation.repositoryHead !== command.repositoryHead ||
					preparation.sentCommitSha !== command.sentCommitSha
				) {
					return { outcome: 'not_eligible' };
				}
				if (
					preparation.auditHead.sequence !== command.expectedAuditSequence ||
					preparation.auditHead.eventHash !== command.previousAuditHash
				) {
					return { outcome: 'audit_conflict' };
				}
				if (!sameStringArray(preparation.revokedRecipientIds, command.revokedRecipientIds)) {
					return { outcome: 'not_eligible' };
				}

				await transaction`
						UPDATE delivery_outbox
						SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
							sealed_capability = NULL,
							available_at = COALESCE(available_at, ${command.expiredAt}::timestamptz),
							last_error = 'envelope_terminal', updated_at = ${command.expiredAt}::timestamptz
						WHERE organization_id = ${command.organizationId} AND envelope_id = ${command.envelopeId}
							AND (status IN ('blocked', 'pending') OR (status = 'failed' AND retryable))`;

				const revokedRows = await transaction<{ id: string }[]>`
						UPDATE recipient SET capability_revoked_at = ${command.expiredAt}::timestamptz,
							updated_at = ${command.expiredAt}::timestamptz
						WHERE organization_id = ${command.organizationId} AND envelope_id = ${command.envelopeId}
							AND status <> 'completed' AND capability_hash IS NOT NULL
							AND capability_revoked_at IS NULL
						RETURNING id`;
				const revokedIds: readonly string[] = revokedRows
					.map((row: { id: string }): string => row.id)
					.sort();
				if (!sameStringArray(revokedIds, command.revokedRecipientIds)) {
					throw new EnvelopeExpiryIntegrityError();
				}

				const envelopeRows = await transaction<{ id: string }[]>`
						UPDATE envelope SET status = 'expired', updated_at = ${command.expiredAt}::timestamptz
						WHERE organization_id = ${command.organizationId} AND id = ${command.envelopeId}
							AND status = ${command.expectedStatus}
							AND repository_generation = ${command.expectedGeneration}
							AND repository_head IS NOT DISTINCT FROM ${command.repositoryHead}
							AND sent_commit_sha IS NOT DISTINCT FROM ${command.sentCommitSha}
						RETURNING id`;
				if (envelopeRows.length !== 1) throw new EnvelopeExpiryIntegrityError();

				await transaction`
						INSERT INTO audit_event (
							id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
							payload_json, previous_hash, event_hash, occurred_at
						) VALUES (${command.auditEventId}, ${command.organizationId}, ${command.envelopeId},
							${command.expectedAuditSequence + 1}, 'envelope.expired', 'system',
							'envelope-expiry-drain', ${command.auditPayloadJson}, ${command.previousAuditHash},
							${command.auditEventHash}, ${command.expiredAt}::timestamptz)`;

				return {
					outcome: 'published',
					result: {
						envelopeId: command.envelopeId,
						expiredAt: command.expiredAt,
						revokedCapabilityCount: command.revokedRecipientIds.length,
						auditEventId: command.auditEventId
					}
				};
			});
		} catch (error: unknown) {
			if (error instanceof EnvelopeExpiryIntegrityError) return { outcome: 'integrity_error' };
			throw error;
		}
	}

	async #prepare(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		now: string,
		lock: boolean
	): Promise<EnvelopeExpiryPreparation> {
		const envelope: EnvelopeRow | null = await this.#readEnvelope(
			sql,
			organizationId,
			envelopeId,
			lock
		);
		if (envelope === null) return { outcome: 'not_eligible' };
		if (!isExpirableStatus(envelope.status)) return { outcome: 'not_eligible' };
		const previousStatus: ExpirableEnvelopeStatus = envelope.status;

		const eligible: boolean = await this.#isEligible(sql, organizationId, envelopeId, now);
		if (!eligible) return { outcome: 'not_eligible' };

		const revokedRecipientIds: readonly string[] = await this.#readRevocableRecipientIds(
			sql,
			organizationId,
			envelopeId
		);
		const auditHead: EnvelopeExpiryAuditHead | null = await this.#readAuditHead(
			sql,
			organizationId,
			envelopeId,
			lock
		);
		if (auditHead === null) return { outcome: 'integrity_error' };

		return {
			outcome: 'ready',
			organizationId,
			envelopeId,
			previousStatus,
			generation: envelope.repositoryGeneration,
			repositoryHead: envelope.repositoryHead,
			sentCommitSha: envelope.sentCommitSha,
			auditHead,
			revokedRecipientIds
		};
	}

	async #readEnvelope(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		lock: boolean
	): Promise<EnvelopeRow | null> {
		const rows = lock
			? await sql<EnvelopeRow[]>`
				SELECT status, repository_generation AS "repositoryGeneration",
					repository_head AS "repositoryHead", sent_commit_sha AS "sentCommitSha"
				FROM envelope WHERE organization_id = ${organizationId} AND id = ${envelopeId}
				FOR UPDATE`
			: await sql<EnvelopeRow[]>`
				SELECT status, repository_generation AS "repositoryGeneration",
					repository_head AS "repositoryHead", sent_commit_sha AS "sentCommitSha"
				FROM envelope WHERE organization_id = ${organizationId} AND id = ${envelopeId}`;
		return rows[0] ?? null;
	}

	async #isEligible(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		now: string
	): Promise<boolean> {
		const rows = await sql<{ eligible: boolean }[]>`
			SELECT (
				EXISTS (
					SELECT 1 FROM recipient
					WHERE recipient.organization_id = ${organizationId} AND recipient.envelope_id = ${envelopeId}
						AND recipient.role IN ('signer', 'approver')
						AND recipient.status IN ('pending', 'viewed')
						AND recipient.capability_expires_at IS NOT NULL
						AND recipient.capability_expires_at <= ${now}::timestamptz
				)
				AND NOT EXISTS (
					SELECT 1 FROM recipient
					WHERE recipient.organization_id = ${organizationId} AND recipient.envelope_id = ${envelopeId}
						AND recipient.role IN ('signer', 'approver')
						AND recipient.status IN ('pending', 'viewed')
						AND recipient.capability_expires_at IS NOT NULL
						AND recipient.capability_expires_at > ${now}::timestamptz
				)
			) AS eligible`;
		return rows[0]?.eligible ?? false;
	}

	async #readRevocableRecipientIds(
		sql: Sql,
		organizationId: string,
		envelopeId: string
	): Promise<readonly string[]> {
		const rows = await sql<{ id: string }[]>`
			SELECT id FROM recipient WHERE organization_id = ${organizationId}
				AND envelope_id = ${envelopeId} AND status <> 'completed'
				AND capability_hash IS NOT NULL AND capability_revoked_at IS NULL ORDER BY id`;
		return rows.map((row: { id: string }): string => row.id);
	}

	async #readAuditHead(
		sql: Sql,
		organizationId: string,
		envelopeId: string,
		lock: boolean
	): Promise<EnvelopeExpiryAuditHead | null> {
		const rows = lock
			? await sql<AuditHeadRow[]>`
				SELECT sequence, event_hash AS "eventHash" FROM audit_event
				WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
				ORDER BY sequence DESC LIMIT 1 FOR UPDATE`
			: await sql<AuditHeadRow[]>`
				SELECT sequence, event_hash AS "eventHash" FROM audit_event
				WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
				ORDER BY sequence DESC LIMIT 1`;
		const row: AuditHeadRow | undefined = rows[0];
		return row === undefined ? null : { sequence: Number(row.sequence), eventHash: row.eventHash };
	}
}

function isExpirableStatus(value: string): value is ExpirableEnvelopeStatus {
	return value === 'sent' || value === 'in_progress';
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value: string, index: number): boolean => value === right[index])
	);
}
