import {
	MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
	type ClaimedInstanceInvitationDelivery,
	type ClaimInstanceInvitationDeliveriesCommand,
	type CompleteInstanceInvitationDeliveryCommand,
	type CompleteInstanceInvitationDeliveryResult,
	type FailInstanceInvitationDeliveryCommand,
	type FailInstanceInvitationDeliveryResult,
	type InstanceInvitationDeliveryStore,
	type ReadClaimedInstanceInvitationDeliveryCommand
} from '$lib/ports/instance-invitation-delivery-store';
import type { InstanceInvitationDeliveryLocale } from '$lib/security/instance-invitation-delivery-payload';

interface DeliveryRow {
	delivery_id: string;
	invitation_id: string;
	locale: InstanceInvitationDeliveryLocale;
	role: 'owner' | 'admin' | 'member';
	invitation_status: 'pending' | 'accepted' | 'revoked';
	expires_at: string;
	token_hash: string;
	email_binding: string;
	sealed_payload: string | null;
	sealed_payload_sha256: string;
	sealing_key_id: string;
	attempts: number;
}

const COLUMNS: string = `delivery.id AS delivery_id, delivery.invitation_id AS invitation_id,
	delivery.locale, invitation.role, invitation.status AS invitation_status,
	invitation.expires_at, invitation.token_hash, invitation.email_binding,
	delivery.sealed_payload, delivery.sealed_payload_sha256,
	delivery.sealing_key_id, delivery.attempts`;

export class D1InstanceInvitationDeliveryStore implements InstanceInvitationDeliveryStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async claimPending(
		command: ClaimInstanceInvitationDeliveriesCommand
	): Promise<readonly ClaimedInstanceInvitationDelivery[]> {
		const cleanup: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE instance_invitation_delivery_outbox
				 SET status = 'failed', retryable = 0, sealed_payload = NULL,
				     claim_token = NULL, locked_at = NULL,
				     last_error = CASE
				       WHEN attempts >= ? THEN 'delivery_attempts_exhausted'
				       ELSE 'invitation_not_active'
				     END,
				     updated_at = ?
				 WHERE id IN (
				   SELECT delivery.id FROM instance_invitation_delivery_outbox delivery
				   INNER JOIN instance_invitation invitation ON invitation.id = delivery.invitation_id
				   WHERE delivery.retryable = 1
				     AND (
				       invitation.status <> 'pending' OR invitation.expires_at <= ?
				       OR (delivery.attempts >= ? AND
				         (delivery.status <> 'processing' OR delivery.locked_at < ?))
				     )
				   ORDER BY delivery.updated_at, delivery.id LIMIT 100
				 )`
			)
			.bind(
				MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
				command.claimedAt,
				command.claimedAt,
				MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
				command.staleBefore
			);
		const claim: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE instance_invitation_delivery_outbox
				 SET status = 'processing', claim_token = ?, locked_at = ?,
				     attempts = attempts + 1, updated_at = ?
				 WHERE id IN (
				   SELECT delivery.id FROM instance_invitation_delivery_outbox delivery
				   INNER JOIN instance_invitation invitation ON invitation.id = delivery.invitation_id
				   WHERE ((delivery.status IN ('pending', 'failed') AND delivery.retryable = 1
				             AND delivery.available_at <= ?)
				          OR (delivery.status = 'processing' AND delivery.locked_at < ?))
				     AND delivery.attempts < ?
				     AND invitation.status = 'pending' AND invitation.expires_at > ?
				   ORDER BY delivery.available_at, delivery.created_at, delivery.id LIMIT ?
				 )`
			)
			.bind(
				command.claimToken,
				command.claimedAt,
				command.claimedAt,
				command.claimedAt,
				command.staleBefore,
				MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
				command.claimedAt,
				command.limit
			);
		const read: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${COLUMNS}
				 FROM instance_invitation_delivery_outbox delivery
				 INNER JOIN instance_invitation invitation ON invitation.id = delivery.invitation_id
				 WHERE delivery.status = 'processing' AND delivery.claim_token = ?
				 ORDER BY delivery.available_at, delivery.created_at, delivery.id`
			)
			.bind(command.claimToken);
		const results: D1Result[] = await this.#database.batch([cleanup, claim, read]);
		return (results[2].results as unknown as DeliveryRow[]).map(toClaim);
	}

	async readClaimed(
		command: ReadClaimedInstanceInvitationDeliveryCommand
	): Promise<ClaimedInstanceInvitationDelivery | null> {
		const row: DeliveryRow | null = await this.#database
			.prepare(
				`SELECT ${COLUMNS}
				 FROM instance_invitation_delivery_outbox delivery
				 INNER JOIN instance_invitation invitation ON invitation.id = delivery.invitation_id
				 WHERE delivery.id = ? AND delivery.status = 'processing' AND delivery.claim_token = ?`
			)
			.bind(command.deliveryId, command.claimToken)
			.first<DeliveryRow>();
		return row === null ? null : toClaim(row);
	}

	async complete(
		command: CompleteInstanceInvitationDeliveryCommand
	): Promise<CompleteInstanceInvitationDeliveryResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE instance_invitation_delivery_outbox
				 SET status = 'delivered', retryable = 0, sealed_payload = NULL,
				     claim_token = NULL, locked_at = NULL, delivered_at = ?,
				     provider_message_id = ?, last_error = NULL, updated_at = ?
				 WHERE id = ? AND status = 'processing' AND claim_token = ?`
			)
			.bind(
				command.deliveredAt,
				command.providerMessageId,
				command.deliveredAt,
				command.deliveryId,
				command.claimToken
			)
			.run();
		return result.meta.changes === 1 ? { outcome: 'completed' } : { outcome: 'stale' };
	}

	async fail(
		command: FailInstanceInvitationDeliveryCommand
	): Promise<FailInstanceInvitationDeliveryResult> {
		const result: D1Result = await this.#database
			.prepare(
				command.retryable
					? `UPDATE instance_invitation_delivery_outbox
					   SET status = 'failed', retryable = 1, claim_token = NULL, locked_at = NULL,
					       available_at = ?, last_error = ?, updated_at = ?
					   WHERE id = ? AND status = 'processing' AND claim_token = ?`
					: `UPDATE instance_invitation_delivery_outbox
					   SET status = 'failed', retryable = 0, sealed_payload = NULL,
					       claim_token = NULL, locked_at = NULL, available_at = ?,
					       last_error = ?, updated_at = ?
					   WHERE id = ? AND status = 'processing' AND claim_token = ?`
			)
			.bind(
				command.nextAvailableAt,
				command.errorCode,
				command.failedAt,
				command.deliveryId,
				command.claimToken
			)
			.run();
		return result.meta.changes === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}
}

function toClaim(row: DeliveryRow): ClaimedInstanceInvitationDelivery {
	return {
		deliveryId: row.delivery_id,
		invitationId: row.invitation_id,
		locale: row.locale,
		role: row.role,
		invitationStatus: row.invitation_status,
		expiresAt: row.expires_at,
		tokenHash: row.token_hash,
		emailBinding: row.email_binding,
		sealedPayload: row.sealed_payload,
		sealedPayloadSha256: row.sealed_payload_sha256,
		sealingKeyId: row.sealing_key_id,
		attempts: row.attempts
	};
}
