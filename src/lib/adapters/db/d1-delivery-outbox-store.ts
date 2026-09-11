import type { EnvelopeStatus, RecipientStatus } from '$lib/domain/envelope';
import type {
	ClaimedInvitationDelivery,
	ClaimInvitationDeliveriesCommand,
	CompleteInvitationDeliveryCommand,
	CompleteInvitationDeliveryResult,
	DeliveryOutboxStore,
	FailInvitationDeliveryCommand,
	FailInvitationDeliveryResult,
	ReadClaimedInvitationCommand,
	RecipientLocale
} from '$lib/ports/delivery-outbox-store';

const MAX_INVITATION_TERMINAL_CLEANUP_BATCH: number = 100;

const CLAIM_CANDIDATE_COLUMNS: string = `delivery.id AS delivery_id,
	delivery.organization_id AS organization_id,
	delivery.envelope_id AS envelope_id,
	delivery.recipient_id AS recipient_id,
	delivery.capability_hash AS capability_hash,
	delivery.reserved_capability_expires_at AS reserved_capability_expires_at,
	delivery.sealed_capability AS sealed_capability,
	delivery.sealing_key_id AS sealing_key_id,
	delivery.sealed_capability_sha256 AS sealed_capability_sha256,
	delivery.available_at AS available_at,
	delivery.attempts AS attempts,
	delivery.locked_at AS locked_at,
	recipient.email AS recipient_email,
	recipient.name AS recipient_name,
	recipient.locale AS recipient_locale,
	recipient.status AS recipient_status,
	recipient.capability_expires_at AS recipient_capability_expires_at,
	recipient.capability_revoked_at AS recipient_capability_revoked_at,
	envelope.title AS envelope_title,
	envelope.status AS envelope_status`;

const CLAIM_CANDIDATE_JOIN: string = `FROM delivery_outbox delivery
	INNER JOIN recipient
		ON recipient.organization_id = delivery.organization_id
		AND recipient.id = delivery.recipient_id
		AND recipient.envelope_id = delivery.envelope_id
	INNER JOIN envelope
		ON envelope.organization_id = delivery.organization_id
		AND envelope.id = delivery.envelope_id
	WHERE delivery.kind = 'recipient_invitation'
		AND (
			(delivery.status IN ('pending', 'failed') AND delivery.retryable = 1 AND delivery.available_at <= ?)
			OR (delivery.status = 'processing' AND delivery.locked_at < ?)
		)
		AND envelope.status IN ('sent', 'in_progress')
		AND recipient.status = 'pending'
		AND recipient.role <> 'cc'
		AND recipient.capability_revoked_at IS NULL
		AND recipient.capability_expires_at IS NOT NULL
		AND julianday(recipient.capability_expires_at) > julianday(?)
		AND recipient.capability_hash = delivery.capability_hash
		AND recipient.capability_expires_at = delivery.reserved_capability_expires_at`;

const READ_CLAIMED_INVITATION_QUERY: string = `SELECT ${CLAIM_CANDIDATE_COLUMNS}
	FROM delivery_outbox delivery
	INNER JOIN recipient
		ON recipient.organization_id = delivery.organization_id
		AND recipient.id = delivery.recipient_id
		AND recipient.envelope_id = delivery.envelope_id
	INNER JOIN envelope
		ON envelope.organization_id = delivery.organization_id
		AND envelope.id = delivery.envelope_id
	WHERE delivery.organization_id = ?
		AND delivery.id = ?
		AND delivery.status = 'processing'
		AND delivery.claim_token = ?`;

const D1_TERMINAL_CLEANUP_QUERY: string = `WITH terminal_candidates(rowid) AS (
	SELECT delivery.rowid
	FROM delivery_outbox delivery
	INNER JOIN recipient
		ON recipient.organization_id = delivery.organization_id
		AND recipient.id = delivery.recipient_id
		AND recipient.envelope_id = delivery.envelope_id
	INNER JOIN envelope
		ON envelope.organization_id = delivery.organization_id
		AND envelope.id = delivery.envelope_id
	WHERE delivery.kind = 'recipient_invitation'
		AND delivery.retryable = 1
		AND delivery.sealed_capability IS NOT NULL
		AND (
			delivery.status IN ('blocked', 'pending', 'failed')
			OR (delivery.status = 'processing' AND delivery.locked_at < ?)
		)
		AND NOT (
			envelope.status IN ('sent', 'in_progress')
			AND recipient.status = 'pending'
			AND recipient.role <> 'cc'
			AND recipient.capability_revoked_at IS NULL
			AND recipient.capability_hash = delivery.capability_hash
			AND (
				(delivery.status = 'blocked'
					AND recipient.capability_expires_at IS NULL
					AND delivery.reserved_capability_expires_at IS NULL)
				OR (delivery.status <> 'blocked'
					AND recipient.capability_expires_at IS NOT NULL
					AND julianday(recipient.capability_expires_at) > julianday(?)
					AND recipient.capability_expires_at = delivery.reserved_capability_expires_at)
			)
		)
	ORDER BY delivery.updated_at ASC, delivery.created_at ASC, delivery.id ASC
	LIMIT ?
)
UPDATE delivery_outbox
	SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 0,
		sealed_capability = NULL, available_at = COALESCE(available_at, ?),
		last_error = 'delivery_not_eligible', updated_at = ?
	WHERE rowid IN (SELECT rowid FROM terminal_candidates)`;

interface ClaimCandidateRow {
	delivery_id: string;
	organization_id: string;
	envelope_id: string;
	recipient_id: string;
	capability_hash: string;
	reserved_capability_expires_at: string | null;
	sealed_capability: string | null;
	sealing_key_id: string;
	sealed_capability_sha256: string;
	available_at: string | null;
	attempts: number;
	locked_at: string | null;
	recipient_email: string;
	recipient_name: string;
	recipient_locale: RecipientLocale;
	recipient_status: RecipientStatus;
	recipient_capability_expires_at: string | null;
	recipient_capability_revoked_at: string | null;
	envelope_title: string;
	envelope_status: EnvelopeStatus;
}

export class D1DeliveryOutboxStore implements DeliveryOutboxStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async claimPendingInvitations(
		command: ClaimInvitationDeliveriesCommand
	): Promise<readonly ClaimedInvitationDelivery[]> {
		const cleanup: D1PreparedStatement = this.#database
			.prepare(D1_TERMINAL_CLEANUP_QUERY)
			.bind(
				command.staleBefore,
				command.claimedAt,
				MAX_INVITATION_TERMINAL_CLEANUP_BATCH,
				command.claimedAt,
				command.claimedAt
			);
		const claim: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE delivery_outbox
				 SET status = 'processing', claim_token = ?, locked_at = ?, attempts = attempts + 1,
					updated_at = ?
				 WHERE rowid IN (
					SELECT delivery.rowid
					${CLAIM_CANDIDATE_JOIN}
					ORDER BY delivery.available_at ASC, delivery.created_at ASC, delivery.id ASC
					LIMIT ?
				 )
				 RETURNING id`
			)
			.bind(
				command.claimToken,
				command.claimedAt,
				command.claimedAt,
				command.claimedAt,
				command.staleBefore,
				command.claimedAt,
				command.limit
			);
		const readClaim: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${CLAIM_CANDIDATE_COLUMNS}
				 FROM delivery_outbox delivery
				 INNER JOIN recipient
					ON recipient.organization_id = delivery.organization_id
					AND recipient.id = delivery.recipient_id
					AND recipient.envelope_id = delivery.envelope_id
				 INNER JOIN envelope
					ON envelope.organization_id = delivery.organization_id
					AND envelope.id = delivery.envelope_id
				 WHERE delivery.status = 'processing' AND delivery.claim_token = ?
				 ORDER BY delivery.available_at ASC, delivery.created_at ASC, delivery.id ASC`
			)
			.bind(command.claimToken);
		const results: D1Result[] = await this.#database.batch([cleanup, claim, readClaim]);
		const rows: readonly ClaimCandidateRow[] = results[2].results as ClaimCandidateRow[];
		return rows.map(toClaimedDelivery);
	}

	async readClaimedInvitation(
		command: ReadClaimedInvitationCommand
	): Promise<ClaimedInvitationDelivery | null> {
		const row: ClaimCandidateRow | null = await this.#database
			.prepare(READ_CLAIMED_INVITATION_QUERY)
			.bind(command.organizationId, command.deliveryId, command.claimToken)
			.first<ClaimCandidateRow>();
		return row === null ? null : toClaimedDelivery(row);
	}

	async completeInvitationDelivery(
		command: CompleteInvitationDeliveryCommand
	): Promise<CompleteInvitationDeliveryResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE delivery_outbox
				 SET status = 'delivered', claim_token = NULL, locked_at = NULL, retryable = 0,
					sealed_capability = NULL, delivered_at = ?, provider_message_id = ?,
					last_error = NULL, updated_at = ?
				 WHERE organization_id = ? AND id = ? AND status = 'processing' AND claim_token = ?`
			)
			.bind(
				command.deliveredAt,
				command.providerMessageId,
				command.deliveredAt,
				command.organizationId,
				command.deliveryId,
				command.claimToken
			)
			.run();
		return result.meta.changes === 1 ? { outcome: 'completed' } : { outcome: 'stale' };
	}

	async failInvitationDelivery(
		command: FailInvitationDeliveryCommand
	): Promise<FailInvitationDeliveryResult> {
		const result: D1Result = command.retryable
			? await this.#database
					.prepare(
						`UPDATE delivery_outbox
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 1,
							available_at = ?, last_error = ?, updated_at = ?
						 WHERE organization_id = ? AND id = ? AND status = 'processing' AND claim_token = ?`
					)
					.bind(
						command.nextAvailableAt,
						command.errorCode,
						command.failedAt,
						command.organizationId,
						command.deliveryId,
						command.claimToken
					)
					.run()
			: await this.#database
					.prepare(
						`UPDATE delivery_outbox
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 0,
							sealed_capability = NULL, available_at = ?, last_error = ?, updated_at = ?
						 WHERE organization_id = ? AND id = ? AND status = 'processing' AND claim_token = ?`
					)
					.bind(
						command.nextAvailableAt,
						command.errorCode,
						command.failedAt,
						command.organizationId,
						command.deliveryId,
						command.claimToken
					)
					.run();
		return result.meta.changes === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}
}

function toClaimedDelivery(row: ClaimCandidateRow): ClaimedInvitationDelivery {
	if (row.locked_at === null) throw new Error('Claimed delivery is missing its lease timestamp');
	return {
		deliveryId: row.delivery_id,
		organizationId: row.organization_id,
		envelopeId: row.envelope_id,
		recipientId: row.recipient_id,
		kind: 'recipient_invitation',
		status: 'processing',
		recipientEmail: row.recipient_email,
		recipientName: row.recipient_name,
		recipientLocale: row.recipient_locale,
		recipientStatus: row.recipient_status,
		envelopeTitle: row.envelope_title,
		envelopeStatus: row.envelope_status,
		capabilityHash: row.capability_hash,
		capabilityExpiresAt: row.recipient_capability_expires_at,
		reservedCapabilityExpiresAt: row.reserved_capability_expires_at,
		capabilityRevokedAt: row.recipient_capability_revoked_at,
		sealedCapability: row.sealed_capability,
		sealedCapabilitySha256: row.sealed_capability_sha256,
		sealingKeyId: row.sealing_key_id,
		availableAt: row.available_at as string,
		attempts: row.attempts,
		lockedAt: row.locked_at
	};
}
