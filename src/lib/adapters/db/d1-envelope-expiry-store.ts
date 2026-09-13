import type {
	DiscoverExpirableEnvelopesCommand,
	EnvelopeExpiryPreparation,
	EnvelopeExpiryStore,
	ExpirableEnvelopeId,
	ExpirableEnvelopeStatus,
	PublishEnvelopeExpiryCommand,
	PublishEnvelopeExpiryResult
} from '$lib/ports/envelope-expiry-store';

interface EnvelopeRow {
	status: string;
	repository_generation: number;
	repository_head: string | null;
	sent_commit_sha: string | null;
}

interface AuditHeadRow {
	sequence: number;
	event_hash: string;
}

export class D1EnvelopeExpiryStore implements EnvelopeExpiryStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async discoverExpirableEnvelopes(
		command: DiscoverExpirableEnvelopesCommand
	): Promise<readonly ExpirableEnvelopeId[]> {
		const result: D1Result<{ organization_id: string; id: string }> = await this.#database
			.prepare(
				`SELECT envelope.organization_id, envelope.id
				 FROM envelope
				 WHERE envelope.status IN ('sent', 'in_progress')
					AND EXISTS (
						SELECT 1 FROM recipient
						WHERE recipient.organization_id = envelope.organization_id
							AND recipient.envelope_id = envelope.id
							AND recipient.role IN ('signer', 'approver')
							AND recipient.status IN ('pending', 'viewed')
							AND recipient.capability_expires_at IS NOT NULL
							AND julianday(recipient.capability_expires_at) <= julianday(?)
					)
					AND NOT EXISTS (
						SELECT 1 FROM recipient
						WHERE recipient.organization_id = envelope.organization_id
							AND recipient.envelope_id = envelope.id
							AND recipient.role IN ('signer', 'approver')
							AND recipient.status IN ('pending', 'viewed')
							AND recipient.capability_expires_at IS NOT NULL
							AND julianday(recipient.capability_expires_at) > julianday(?)
					)
				 ORDER BY envelope.updated_at ASC, envelope.id ASC
				 LIMIT ?`
			)
			.bind(command.now, command.now, command.limit)
			.all<{ organization_id: string; id: string }>();
		return result.results.map((row): ExpirableEnvelopeId => ({
			organizationId: row.organization_id,
			envelopeId: row.id
		}));
	}

	async prepareEnvelopeExpiry(
		organizationId: string,
		envelopeId: string,
		now: string
	): Promise<EnvelopeExpiryPreparation> {
		return await this.#prepare(organizationId, envelopeId, now);
	}

	async publishEnvelopeExpiry(
		command: PublishEnvelopeExpiryCommand
	): Promise<PublishEnvelopeExpiryResult> {
		const statement: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO envelope_expiry_command (
					organization_id, envelope_id, previous_status, expected_generation,
					repository_head, sent_commit_sha, updated_at, audit_event_id, audit_sequence,
					previous_audit_hash, audit_event_hash, audit_payload_json,
					revoked_recipient_ids_json, revoked_recipient_count
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.organizationId,
				command.envelopeId,
				command.expectedStatus,
				command.expectedGeneration,
				command.repositoryHead,
				command.sentCommitSha,
				command.expiredAt,
				command.auditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventHash,
				command.auditPayloadJson,
				JSON.stringify(command.revokedRecipientIds),
				command.revokedRecipientIds.length
			);
		try {
			await this.#database.batch([statement]);
			return {
				outcome: 'published',
				result: {
					envelopeId: command.envelopeId,
					expiredAt: command.expiredAt,
					revokedCapabilityCount: command.revokedRecipientIds.length,
					auditEventId: command.auditEventId
				}
			};
		} catch (error: unknown) {
			const classified: EnvelopeExpiryPreparation = await this.#prepare(
				command.organizationId,
				command.envelopeId,
				command.expiredAt
			);
			if (classified.outcome !== 'ready') return { outcome: classified.outcome };
			if (
				classified.auditHead.sequence !== command.expectedAuditSequence ||
				classified.auditHead.eventHash !== command.previousAuditHash
			) {
				return { outcome: 'audit_conflict' };
			}
			if (
				classified.previousStatus !== command.expectedStatus ||
				classified.generation !== command.expectedGeneration ||
				classified.repositoryHead !== command.repositoryHead ||
				classified.sentCommitSha !== command.sentCommitSha ||
				!sameStringArray(classified.revokedRecipientIds, command.revokedRecipientIds)
			) {
				return { outcome: 'integrity_error' };
			}
			throw error;
		}
	}

	async #prepare(
		organizationId: string,
		envelopeId: string,
		now: string
	): Promise<EnvelopeExpiryPreparation> {
		const envelope: EnvelopeRow | null = await this.#database
			.prepare(
				`SELECT status, repository_generation, repository_head, sent_commit_sha
				 FROM envelope WHERE organization_id = ? AND id = ? LIMIT 1`
			)
			.bind(organizationId, envelopeId)
			.first<EnvelopeRow>();
		if (envelope === null) return { outcome: 'not_eligible' };
		if (!isExpirableStatus(envelope.status)) return { outcome: 'not_eligible' };
		const previousStatus: ExpirableEnvelopeStatus = envelope.status;

		const eligibility: { eligible: number } | null = await this.#database
			.prepare(
				`SELECT (
					EXISTS (
						SELECT 1 FROM recipient
						WHERE organization_id = ? AND envelope_id = ?
							AND role IN ('signer', 'approver')
							AND status IN ('pending', 'viewed')
							AND capability_expires_at IS NOT NULL
							AND julianday(capability_expires_at) <= julianday(?)
					)
					AND NOT EXISTS (
						SELECT 1 FROM recipient
						WHERE organization_id = ? AND envelope_id = ?
							AND role IN ('signer', 'approver')
							AND status IN ('pending', 'viewed')
							AND capability_expires_at IS NOT NULL
							AND julianday(capability_expires_at) > julianday(?)
					)
				) AS eligible`
			)
			.bind(organizationId, envelopeId, now, organizationId, envelopeId, now)
			.first<{ eligible: number }>();
		if (eligibility === null || eligibility.eligible !== 1) return { outcome: 'not_eligible' };

		const revocableResult: D1Result<{ id: string }> = await this.#database
			.prepare(
				`SELECT id FROM recipient WHERE organization_id = ? AND envelope_id = ?
					AND status <> 'completed' AND capability_hash IS NOT NULL
					AND capability_revoked_at IS NULL ORDER BY id`
			)
			.bind(organizationId, envelopeId)
			.all<{ id: string }>();
		const revokedRecipientIds: readonly string[] = revocableResult.results.map(
			(row: { id: string }): string => row.id
		);

		const auditHead: AuditHeadRow | null = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE organization_id = ? AND envelope_id = ? ORDER BY sequence DESC LIMIT 1`
			)
			.bind(organizationId, envelopeId)
			.first<AuditHeadRow>();
		if (auditHead === null) return { outcome: 'integrity_error' };

		return {
			outcome: 'ready',
			organizationId,
			envelopeId,
			previousStatus,
			generation: envelope.repository_generation,
			repositoryHead: envelope.repository_head,
			sentCommitSha: envelope.sent_commit_sha,
			auditHead: { sequence: auditHead.sequence, eventHash: auditHead.event_hash },
			revokedRecipientIds
		};
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
