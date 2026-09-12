import postgres from 'postgres';
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

interface ClaimCandidateRow {
	deliveryId: string;
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	capabilityHash: string;
	reservedCapabilityExpiresAt: Date | string | null;
	sealedCapability: string | null;
	sealingKeyId: string;
	sealedCapabilitySha256: string;
	availableAt: Date | string | null;
	attempts: number | string;
	lockedAt: Date | string | null;
	recipientEmail: string;
	recipientName: string;
	recipientLocale: RecipientLocale;
	recipientStatus: RecipientStatus;
	recipientCapabilityExpiresAt: Date | string | null;
	recipientCapabilityRevokedAt: Date | string | null;
	envelopeTitle: string;
	envelopeStatus: EnvelopeStatus;
}

export class PostgresDeliveryOutboxStore implements DeliveryOutboxStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async claimPendingInvitations(
		command: ClaimInvitationDeliveriesCommand
	): Promise<readonly ClaimedInvitationDelivery[]> {
		return await this.#sql.begin(
			async (transaction): Promise<readonly ClaimedInvitationDelivery[]> => {
				await transaction`
					WITH terminal_candidates AS (
						SELECT delivery.organization_id, delivery.id
						FROM delivery_outbox delivery
						INNER JOIN recipient
							ON recipient.organization_id = delivery.organization_id
							AND recipient.id = delivery.recipient_id
							AND recipient.envelope_id = delivery.envelope_id
						INNER JOIN envelope
							ON envelope.organization_id = delivery.organization_id
							AND envelope.id = delivery.envelope_id
						WHERE delivery.kind = 'recipient_invitation'
							AND delivery.retryable
							AND delivery.sealed_capability IS NOT NULL
							AND (
								delivery.status IN ('blocked', 'pending', 'failed')
								OR (delivery.status = 'processing'
									AND delivery.locked_at < ${command.staleBefore}::timestamptz)
							)
							AND NOT (
								envelope.status IN ('sent', 'in_progress')
								AND recipient.status = 'pending'
								AND recipient.role IN ('signer', 'approver', 'viewer')
								AND recipient.capability_revoked_at IS NULL
								AND recipient.capability_hash = delivery.capability_hash
								AND (
									(delivery.status = 'blocked'
										AND recipient.capability_expires_at IS NULL
										AND delivery.reserved_capability_expires_at IS NULL)
									OR (delivery.status <> 'blocked'
										AND recipient.capability_expires_at IS NOT NULL
										AND recipient.capability_expires_at > ${command.claimedAt}::timestamptz
										AND recipient.capability_expires_at = delivery.reserved_capability_expires_at)
								)
							)
						ORDER BY delivery.updated_at ASC, delivery.created_at ASC, delivery.id ASC
						LIMIT ${MAX_INVITATION_TERMINAL_CLEANUP_BATCH}
						FOR UPDATE OF delivery SKIP LOCKED
					)
					UPDATE delivery_outbox AS delivery
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
						sealed_capability = NULL,
						available_at = COALESCE(delivery.available_at, ${command.claimedAt}::timestamptz),
						last_error = 'delivery_not_eligible', updated_at = ${command.claimedAt}::timestamptz
					FROM terminal_candidates candidate
					WHERE candidate.organization_id = delivery.organization_id
						AND candidate.id = delivery.id`;
				const candidates = await transaction<ClaimCandidateRow[]>`
					SELECT delivery.id AS "deliveryId",
						delivery.organization_id AS "organizationId",
						delivery.envelope_id AS "envelopeId",
						delivery.recipient_id AS "recipientId",
						delivery.capability_hash AS "capabilityHash",
						delivery.reserved_capability_expires_at AS "reservedCapabilityExpiresAt",
						delivery.sealed_capability AS "sealedCapability",
						delivery.sealing_key_id AS "sealingKeyId",
						delivery.sealed_capability_sha256 AS "sealedCapabilitySha256",
						delivery.available_at AS "availableAt",
						delivery.attempts AS "attempts",
						delivery.locked_at AS "lockedAt",
						recipient.email AS "recipientEmail",
						recipient.name AS "recipientName",
						recipient.locale AS "recipientLocale",
						recipient.status AS "recipientStatus",
						recipient.capability_expires_at AS "recipientCapabilityExpiresAt",
						recipient.capability_revoked_at AS "recipientCapabilityRevokedAt",
						envelope.title AS "envelopeTitle",
						envelope.status AS "envelopeStatus"
					FROM delivery_outbox delivery
					INNER JOIN recipient
						ON recipient.organization_id = delivery.organization_id
						AND recipient.id = delivery.recipient_id
						AND recipient.envelope_id = delivery.envelope_id
					INNER JOIN envelope
						ON envelope.organization_id = delivery.organization_id
						AND envelope.id = delivery.envelope_id
					WHERE delivery.kind = 'recipient_invitation'
						AND (
							(delivery.status IN ('pending', 'failed') AND delivery.retryable
								AND delivery.available_at <= ${command.claimedAt}::timestamptz)
							OR (delivery.status = 'processing'
								AND delivery.locked_at < ${command.staleBefore}::timestamptz)
						)
						AND envelope.status IN ('sent', 'in_progress')
						AND recipient.status = 'pending'
						AND recipient.role IN ('signer', 'approver', 'viewer')
						AND recipient.capability_revoked_at IS NULL
						AND recipient.capability_expires_at IS NOT NULL
						AND recipient.capability_expires_at > ${command.claimedAt}::timestamptz
						AND recipient.capability_hash = delivery.capability_hash
						AND recipient.capability_expires_at = delivery.reserved_capability_expires_at
					ORDER BY delivery.available_at ASC, delivery.created_at ASC, delivery.id ASC
					LIMIT ${command.limit}
					FOR UPDATE OF delivery SKIP LOCKED`;
				if (candidates.length === 0) return [];

				const claimed: ClaimedInvitationDelivery[] = [];
				for (const row of candidates) {
					const updated = await transaction<{ id: string }[]>`
						UPDATE delivery_outbox
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}, attempts = attempts + 1,
							updated_at = ${command.claimedAt}
						WHERE organization_id = ${row.organizationId} AND id = ${row.deliveryId}
							AND (
								(status IN ('pending', 'failed') AND retryable
									AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing' AND locked_at < ${command.staleBefore}::timestamptz)
							)
						RETURNING id`;
					if (updated.length === 1) claimed.push(toClaimedDelivery(row, command.claimedAt, 1));
				}
				return claimed;
			}
		);
	}

	async readClaimedInvitation(
		command: ReadClaimedInvitationCommand
	): Promise<ClaimedInvitationDelivery | null> {
		const rows = await this.#sql<ClaimCandidateRow[]>`
			SELECT delivery.id AS "deliveryId",
				delivery.organization_id AS "organizationId",
				delivery.envelope_id AS "envelopeId",
				delivery.recipient_id AS "recipientId",
				delivery.capability_hash AS "capabilityHash",
				delivery.reserved_capability_expires_at AS "reservedCapabilityExpiresAt",
				delivery.sealed_capability AS "sealedCapability",
				delivery.sealing_key_id AS "sealingKeyId",
				delivery.sealed_capability_sha256 AS "sealedCapabilitySha256",
				delivery.available_at AS "availableAt",
				delivery.attempts AS "attempts",
				delivery.locked_at AS "lockedAt",
				recipient.email AS "recipientEmail",
				recipient.name AS "recipientName",
				recipient.locale AS "recipientLocale",
				recipient.status AS "recipientStatus",
				recipient.capability_expires_at AS "recipientCapabilityExpiresAt",
				recipient.capability_revoked_at AS "recipientCapabilityRevokedAt",
				envelope.title AS "envelopeTitle",
				envelope.status AS "envelopeStatus"
			FROM delivery_outbox delivery
			INNER JOIN recipient
				ON recipient.organization_id = delivery.organization_id
				AND recipient.id = delivery.recipient_id
				AND recipient.envelope_id = delivery.envelope_id
			INNER JOIN envelope
				ON envelope.organization_id = delivery.organization_id
				AND envelope.id = delivery.envelope_id
			WHERE delivery.organization_id = ${command.organizationId}
				AND delivery.id = ${command.deliveryId}
				AND delivery.status = 'processing'
				AND delivery.claim_token = ${command.claimToken}`;
		const row: ClaimCandidateRow | undefined = rows[0];
		if (row === undefined) return null;
		const lockedAt: string | null = isoTimestampOrNull(row.lockedAt);
		if (lockedAt === null) throw new Error('Claimed delivery is missing its lease timestamp');
		return toClaimedDelivery(row, lockedAt, 0);
	}

	async completeInvitationDelivery(
		command: CompleteInvitationDeliveryCommand
	): Promise<CompleteInvitationDeliveryResult> {
		const rows = await this.#sql<{ id: string }[]>`
			UPDATE delivery_outbox
			SET status = 'delivered', claim_token = NULL, locked_at = NULL, retryable = false,
				sealed_capability = NULL, delivered_at = ${command.deliveredAt},
				provider_message_id = ${command.providerMessageId}, last_error = NULL,
				updated_at = ${command.deliveredAt}
			WHERE organization_id = ${command.organizationId} AND id = ${command.deliveryId}
				AND status = 'processing' AND claim_token = ${command.claimToken}
			RETURNING id`;
		return rows.length === 1 ? { outcome: 'completed' } : { outcome: 'stale' };
	}

	async failInvitationDelivery(
		command: FailInvitationDeliveryCommand
	): Promise<FailInvitationDeliveryResult> {
		const rows = command.retryable
			? await this.#sql<{ id: string }[]>`
					UPDATE delivery_outbox
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = true,
						available_at = ${command.nextAvailableAt}, last_error = ${command.errorCode},
						updated_at = ${command.failedAt}
					WHERE organization_id = ${command.organizationId} AND id = ${command.deliveryId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING id`
			: await this.#sql<{ id: string }[]>`
					UPDATE delivery_outbox
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
						sealed_capability = NULL, available_at = ${command.nextAvailableAt},
						last_error = ${command.errorCode}, updated_at = ${command.failedAt}
					WHERE organization_id = ${command.organizationId} AND id = ${command.deliveryId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING id`;
		return rows.length === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}
}

function toClaimedDelivery(
	row: ClaimCandidateRow,
	claimedAt: string,
	attemptIncrement: number
): ClaimedInvitationDelivery {
	return {
		deliveryId: row.deliveryId,
		organizationId: row.organizationId,
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		kind: 'recipient_invitation',
		status: 'processing',
		recipientEmail: row.recipientEmail,
		recipientName: row.recipientName,
		recipientLocale: row.recipientLocale,
		recipientStatus: row.recipientStatus,
		envelopeTitle: row.envelopeTitle,
		envelopeStatus: row.envelopeStatus,
		capabilityHash: row.capabilityHash,
		capabilityExpiresAt: isoTimestampOrNull(row.recipientCapabilityExpiresAt),
		reservedCapabilityExpiresAt: isoTimestampOrNull(row.reservedCapabilityExpiresAt),
		capabilityRevokedAt: isoTimestampOrNull(row.recipientCapabilityRevokedAt),
		sealedCapability: row.sealedCapability,
		sealedCapabilitySha256: row.sealedCapabilitySha256,
		sealingKeyId: row.sealingKeyId,
		availableAt: isoTimestampOrNull(row.availableAt) as string,
		attempts: Number(row.attempts) + attemptIncrement,
		lockedAt: claimedAt
	};
}

function isoTimestampOrNull(value: Date | string | null): string | null {
	if (value === null) return null;
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
