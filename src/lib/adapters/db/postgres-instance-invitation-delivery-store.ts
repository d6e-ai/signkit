import postgres from 'postgres';
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
	deliveryId: string;
	invitationId: string;
	locale: InstanceInvitationDeliveryLocale;
	role: 'owner' | 'admin' | 'member';
	invitationStatus: 'pending' | 'accepted' | 'revoked';
	expiresAt: Date | string;
	tokenHash: string;
	emailBinding: string;
	sealedPayload: string | null;
	sealedPayloadSha256: string;
	sealingKeyId: string;
	attempts: number | string;
}

export class PostgresInstanceInvitationDeliveryStore implements InstanceInvitationDeliveryStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async claimPending(
		command: ClaimInstanceInvitationDeliveriesCommand
	): Promise<readonly ClaimedInstanceInvitationDelivery[]> {
		return await this.#sql.begin(
			async (transaction): Promise<readonly ClaimedInstanceInvitationDelivery[]> => {
				await transaction`
				WITH candidates AS (
				  SELECT delivery.id FROM instance_invitation_delivery_outbox delivery
				  INNER JOIN instance_invitation invitation ON invitation.id = delivery.invitation_id
				  WHERE delivery.retryable
				    AND (
				      invitation.status <> 'pending'
				      OR invitation.expires_at <= ${command.claimedAt}::timestamptz
				      OR (delivery.attempts >= ${MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS}
				        AND (delivery.status <> 'processing'
				          OR delivery.locked_at < ${command.staleBefore}::timestamptz))
				    )
				  ORDER BY delivery.updated_at, delivery.id LIMIT 100
				  FOR UPDATE OF delivery SKIP LOCKED
				)
				UPDATE instance_invitation_delivery_outbox delivery
				SET status = 'failed', retryable = false, sealed_payload = NULL,
				    claim_token = NULL, locked_at = NULL,
				    last_error = CASE
				      WHEN delivery.attempts >= ${MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS}
				        THEN 'delivery_attempts_exhausted'
				      ELSE 'invitation_not_active'
				    END,
				    updated_at = ${command.claimedAt}::timestamptz
				FROM candidates WHERE candidates.id = delivery.id`;

				const rows = await transaction<DeliveryRow[]>`
				WITH candidates AS (
				  SELECT delivery.id FROM instance_invitation_delivery_outbox delivery
				  INNER JOIN instance_invitation invitation ON invitation.id = delivery.invitation_id
				  WHERE ((delivery.status IN ('pending', 'failed') AND delivery.retryable
				          AND delivery.available_at <= ${command.claimedAt}::timestamptz)
				         OR (delivery.status = 'processing' AND delivery.locked_at < ${command.staleBefore}::timestamptz))
				    AND delivery.attempts < ${MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS}
				    AND invitation.status = 'pending' AND invitation.expires_at > ${command.claimedAt}::timestamptz
				  ORDER BY delivery.available_at, delivery.created_at, delivery.id
				  LIMIT ${command.limit} FOR UPDATE OF delivery SKIP LOCKED
				), claimed AS (
				  UPDATE instance_invitation_delivery_outbox delivery
				  SET status = 'processing', claim_token = ${command.claimToken},
				      locked_at = ${command.claimedAt}::timestamptz,
				      attempts = attempts + 1, updated_at = ${command.claimedAt}::timestamptz
				  FROM candidates WHERE candidates.id = delivery.id RETURNING delivery.*
				)
				SELECT claimed.id AS "deliveryId", claimed.invitation_id AS "invitationId",
				  claimed.locale, invitation.role, invitation.status AS "invitationStatus",
				  invitation.expires_at AS "expiresAt", invitation.token_hash AS "tokenHash",
				  invitation.email_binding AS "emailBinding", claimed.sealed_payload AS "sealedPayload",
				  claimed.sealed_payload_sha256 AS "sealedPayloadSha256",
				  claimed.sealing_key_id AS "sealingKeyId", claimed.attempts
				FROM claimed INNER JOIN instance_invitation invitation ON invitation.id = claimed.invitation_id
				ORDER BY claimed.available_at, claimed.created_at, claimed.id`;
				return rows.map(toClaim);
			}
		);
	}

	async readClaimed(
		command: ReadClaimedInstanceInvitationDeliveryCommand
	): Promise<ClaimedInstanceInvitationDelivery | null> {
		const rows = await this.#sql<DeliveryRow[]>`
			SELECT delivery.id AS "deliveryId", delivery.invitation_id AS "invitationId",
			  delivery.locale, invitation.role, invitation.status AS "invitationStatus",
			  invitation.expires_at AS "expiresAt", invitation.token_hash AS "tokenHash",
			  invitation.email_binding AS "emailBinding", delivery.sealed_payload AS "sealedPayload",
			  delivery.sealed_payload_sha256 AS "sealedPayloadSha256",
			  delivery.sealing_key_id AS "sealingKeyId", delivery.attempts
			FROM instance_invitation_delivery_outbox delivery
			INNER JOIN instance_invitation invitation ON invitation.id = delivery.invitation_id
			WHERE delivery.id = ${command.deliveryId} AND delivery.status = 'processing'
			  AND delivery.claim_token = ${command.claimToken}`;
		return rows[0] === undefined ? null : toClaim(rows[0]);
	}

	async complete(
		command: CompleteInstanceInvitationDeliveryCommand
	): Promise<CompleteInstanceInvitationDeliveryResult> {
		const rows = await this.#sql<{ id: string }[]>`
			UPDATE instance_invitation_delivery_outbox
			SET status = 'delivered', retryable = false, sealed_payload = NULL,
			    claim_token = NULL, locked_at = NULL, delivered_at = ${command.deliveredAt},
			    provider_message_id = ${command.providerMessageId}, last_error = NULL,
			    updated_at = ${command.deliveredAt}
			WHERE id = ${command.deliveryId} AND status = 'processing'
			  AND claim_token = ${command.claimToken} RETURNING id`;
		return rows.length === 1 ? { outcome: 'completed' } : { outcome: 'stale' };
	}

	async fail(
		command: FailInstanceInvitationDeliveryCommand
	): Promise<FailInstanceInvitationDeliveryResult> {
		const rows = command.retryable
			? await this.#sql<{ id: string }[]>`
				UPDATE instance_invitation_delivery_outbox
				SET status = 'failed', retryable = true, claim_token = NULL, locked_at = NULL,
				    available_at = ${command.nextAvailableAt}, last_error = ${command.errorCode},
				    updated_at = ${command.failedAt}
				WHERE id = ${command.deliveryId} AND status = 'processing'
				  AND claim_token = ${command.claimToken} RETURNING id`
			: await this.#sql<{ id: string }[]>`
				UPDATE instance_invitation_delivery_outbox
				SET status = 'failed', retryable = false, sealed_payload = NULL,
				    claim_token = NULL, locked_at = NULL, available_at = ${command.nextAvailableAt},
				    last_error = ${command.errorCode}, updated_at = ${command.failedAt}
				WHERE id = ${command.deliveryId} AND status = 'processing'
				  AND claim_token = ${command.claimToken} RETURNING id`;
		return rows.length === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}
}

function toClaim(row: DeliveryRow): ClaimedInstanceInvitationDelivery {
	const expiresAt: string =
		row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt;
	const attempts: number = typeof row.attempts === 'number' ? row.attempts : Number(row.attempts);
	return { ...row, expiresAt, attempts };
}
