import postgres from 'postgres';
import type { EnvelopeStatus } from '$lib/domain/envelope';
import type {
	ClaimedCompletionDelivery,
	ClaimCompletionDeliveriesCommand,
	CompleteCompletionDeliveryCommand,
	CompleteCompletionDeliveryResult,
	CompletionArtifactLocator,
	CompletionDeliveryStore,
	EligibleCompletionDeliveryRecipient,
	EligibleRecipientRole,
	EnrollCompletionDeliveryItem,
	FailCompletionDeliveryCommand,
	FailCompletionDeliveryResult,
	FindStaleSealedCompletionTokensCommand,
	ReadClaimedCompletionDeliveryCommand,
	RecipientLocale,
	ResealCompletionTokenCommand,
	ResealCompletionTokenResult,
	StaleSealedCompletionTokenRow
} from '$lib/ports/completion-delivery-store';

const MAX_COMPLETION_DELIVERY_TERMINAL_CLEANUP_BATCH: number = 100;

interface ClaimCandidateRow {
	deliveryId: string;
	envelopeId: string;
	recipientId: string;
	tokenHash: string;
	accessExpiresAt: Date | string;
	accessRevokedAt: Date | string | null;
	sealedToken: string | null;
	sealingKeyId: string;
	sealedTokenSha256: string;
	availableAt: Date | string;
	attempts: number | string;
	lockedAt: Date | string | null;
	recipientEmail: string;
	recipientName: string;
	recipientLocale: RecipientLocale;
	recipientRole: EligibleRecipientRole;
	envelopeTitle: string;
	envelopeStatus: EnvelopeStatus;
}

interface DiscoverRecipientRow {
	envelopeId: string;
	recipientId: string;
	recipientEmail: string;
	recipientName: string;
	recipientLocale: RecipientLocale;
	recipientRole: EligibleRecipientRole;
	envelopeTitle: string;
}

interface ArtifactLocatorRow {
	envelopeId: string;
	jsonObjectKey: string;
	jsonSha256: string;
	markdownObjectKey: string;
	markdownSha256: string;
}

export class PostgresCompletionDeliveryStore implements CompletionDeliveryStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async discoverEligibleRecipients(
		limit: number
	): Promise<readonly EligibleCompletionDeliveryRecipient[]> {
		const rows = await this.#sql<DiscoverRecipientRow[]>`
			SELECT
				recipient.envelope_id AS "envelopeId",
				recipient.id AS "recipientId",
				recipient.email AS "recipientEmail",
				recipient.name AS "recipientName",
				recipient.locale AS "recipientLocale",
				recipient.role AS "recipientRole",
				envelope.title AS "envelopeTitle"
			FROM recipient
			INNER JOIN envelope
				ON envelope.id = recipient.envelope_id
			INNER JOIN completion_artifact artifact
				ON artifact.envelope_id = recipient.envelope_id
			WHERE envelope.status = 'completed'
				AND recipient.role IN ('signer', 'approver', 'viewer', 'cc')
				AND NOT EXISTS (
					SELECT 1 FROM completion_delivery_outbox outbox
					WHERE outbox.envelope_id = recipient.envelope_id
						AND outbox.recipient_id = recipient.id
				)
			ORDER BY envelope.updated_at ASC, recipient.routing_order ASC, recipient.id ASC
			LIMIT ${limit}`;

		return rows.map((row: DiscoverRecipientRow): EligibleCompletionDeliveryRecipient => ({
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			recipientEmail: row.recipientEmail,
			recipientName: row.recipientName,
			recipientLocale: row.recipientLocale,
			recipientRole: row.recipientRole,
			envelopeTitle: row.envelopeTitle
		}));
	}

	async enrollDeliveries(items: readonly EnrollCompletionDeliveryItem[]): Promise<number> {
		if (items.length === 0) return 0;
		return await this.#sql.begin(async (transaction): Promise<number> => {
			let insertedCount = 0;
			for (const item of items) {
				const rows = await transaction<{ id: string }[]>`
					INSERT INTO completion_delivery_outbox (
						id, envelope_id, recipient_id, status, token_hash,
						access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
						sealed_token_sha256, available_at, attempts, locked_at, claim_token,
						delivered_at, provider_message_id, last_error, retryable, created_at, updated_at
					) VALUES (
						${item.id}, ${item.envelopeId}, ${item.recipientId}, 'pending', ${item.tokenHash},
						${item.accessExpiresAt}::timestamptz, NULL, ${item.sealedToken}, ${item.sealingKeyId},
						${item.sealedTokenSha256}, ${item.availableAt}::timestamptz, 0, NULL, NULL,
						NULL, NULL, NULL, true, ${item.createdAt}::timestamptz, ${item.createdAt}::timestamptz
					)
					ON CONFLICT (envelope_id, recipient_id) DO NOTHING
					RETURNING id`;
				insertedCount += rows.length;
			}
			return insertedCount;
		});
	}

	async claimPendingDeliveries(
		command: ClaimCompletionDeliveriesCommand
	): Promise<readonly ClaimedCompletionDelivery[]> {
		return await this.#sql.begin(
			async (transaction): Promise<readonly ClaimedCompletionDelivery[]> => {
				await transaction`
					WITH terminal_candidates AS (
						SELECT delivery.id
						FROM completion_delivery_outbox delivery
						INNER JOIN recipient
							ON recipient.id = delivery.recipient_id
							AND recipient.envelope_id = delivery.envelope_id
						INNER JOIN envelope
							ON envelope.id = delivery.envelope_id
						WHERE delivery.retryable
							AND delivery.sealed_token IS NOT NULL
							AND (
								delivery.status IN ('pending', 'failed')
								OR (delivery.status = 'processing'
									AND delivery.locked_at < ${command.staleBefore}::timestamptz)
							)
							AND NOT (
								envelope.status = 'completed'
								AND recipient.role IN ('signer', 'approver', 'viewer', 'cc')
								AND delivery.access_revoked_at IS NULL
								AND delivery.access_expires_at > ${command.claimedAt}::timestamptz
							)
						ORDER BY delivery.updated_at ASC, delivery.created_at ASC, delivery.id ASC
						LIMIT ${MAX_COMPLETION_DELIVERY_TERMINAL_CLEANUP_BATCH}
						FOR UPDATE OF delivery SKIP LOCKED
					)
					UPDATE completion_delivery_outbox AS delivery
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
						sealed_token = NULL,
						access_revoked_at = COALESCE(delivery.access_revoked_at, ${command.claimedAt}::timestamptz),
						available_at = COALESCE(delivery.available_at, ${command.claimedAt}::timestamptz),
						last_error = 'delivery_not_eligible', updated_at = ${command.claimedAt}::timestamptz
					FROM terminal_candidates candidate
					WHERE candidate.id = delivery.id`;

				const candidates = await transaction<ClaimCandidateRow[]>`
					SELECT delivery.id AS "deliveryId",
						delivery.envelope_id AS "envelopeId",
						delivery.recipient_id AS "recipientId",
						delivery.token_hash AS "tokenHash",
						delivery.access_expires_at AS "accessExpiresAt",
						delivery.access_revoked_at AS "accessRevokedAt",
						delivery.sealed_token AS "sealedToken",
						delivery.sealing_key_id AS "sealingKeyId",
						delivery.sealed_token_sha256 AS "sealedTokenSha256",
						delivery.available_at AS "availableAt",
						delivery.attempts AS "attempts",
						delivery.locked_at AS "lockedAt",
						recipient.email AS "recipientEmail",
						recipient.name AS "recipientName",
						recipient.locale AS "recipientLocale",
						recipient.role AS "recipientRole",
						envelope.title AS "envelopeTitle",
						envelope.status AS "envelopeStatus"
					FROM completion_delivery_outbox delivery
					INNER JOIN recipient
						ON recipient.id = delivery.recipient_id
						AND recipient.envelope_id = delivery.envelope_id
					INNER JOIN envelope
						ON envelope.id = delivery.envelope_id
					INNER JOIN completion_artifact artifact
						ON artifact.envelope_id = delivery.envelope_id
					WHERE (
							(delivery.status IN ('pending', 'failed') AND delivery.retryable
								AND delivery.available_at <= ${command.claimedAt}::timestamptz)
							OR (delivery.status = 'processing'
								AND delivery.locked_at < ${command.staleBefore}::timestamptz)
						)
						AND envelope.status = 'completed'
						AND recipient.role IN ('signer', 'approver', 'viewer', 'cc')
						AND delivery.access_revoked_at IS NULL
						AND delivery.access_expires_at > ${command.claimedAt}::timestamptz
						AND delivery.sealed_token IS NOT NULL
					ORDER BY delivery.available_at ASC, delivery.created_at ASC, delivery.id ASC
					LIMIT ${command.limit}
					FOR UPDATE OF delivery SKIP LOCKED`;

				if (candidates.length === 0) return [];

				const claimed: ClaimedCompletionDelivery[] = [];
				for (const row of candidates) {
					const updated = await transaction<{ id: string }[]>`
						UPDATE completion_delivery_outbox
						SET status = 'processing', claim_token = ${command.claimToken},
							locked_at = ${command.claimedAt}::timestamptz, attempts = attempts + 1,
							updated_at = ${command.claimedAt}::timestamptz
						WHERE id = ${row.deliveryId}
							AND (
								(status IN ('pending', 'failed') AND retryable
									AND available_at <= ${command.claimedAt}::timestamptz)
								OR (status = 'processing' AND locked_at < ${command.staleBefore}::timestamptz)
							)
						RETURNING id`;
					if (updated.length === 1) {
						claimed.push(toClaimedDelivery(row, command.claimedAt, 1));
					}
				}
				return claimed;
			}
		);
	}

	async readClaimedDelivery(
		command: ReadClaimedCompletionDeliveryCommand
	): Promise<ClaimedCompletionDelivery | null> {
		const rows = await this.#sql<ClaimCandidateRow[]>`
			SELECT delivery.id AS "deliveryId",
				delivery.envelope_id AS "envelopeId",
				delivery.recipient_id AS "recipientId",
				delivery.token_hash AS "tokenHash",
				delivery.access_expires_at AS "accessExpiresAt",
				delivery.access_revoked_at AS "accessRevokedAt",
				delivery.sealed_token AS "sealedToken",
				delivery.sealing_key_id AS "sealingKeyId",
				delivery.sealed_token_sha256 AS "sealedTokenSha256",
				delivery.available_at AS "availableAt",
				delivery.attempts AS "attempts",
				delivery.locked_at AS "lockedAt",
				recipient.email AS "recipientEmail",
				recipient.name AS "recipientName",
				recipient.locale AS "recipientLocale",
				recipient.role AS "recipientRole",
				envelope.title AS "envelopeTitle",
				envelope.status AS "envelopeStatus"
			FROM completion_delivery_outbox delivery
			INNER JOIN recipient
				ON recipient.id = delivery.recipient_id
				AND recipient.envelope_id = delivery.envelope_id
			INNER JOIN envelope
				ON envelope.id = delivery.envelope_id
			WHERE delivery.id = ${command.deliveryId}
				AND delivery.status = 'processing'
				AND delivery.claim_token = ${command.claimToken}`;
		const row: ClaimCandidateRow | undefined = rows[0];
		if (row === undefined) return null;
		const lockedAt: string | null = isoTimestampOrNull(row.lockedAt);
		if (lockedAt === null) {
			throw new Error('Claimed delivery is missing its lease timestamp');
		}
		return toClaimedDelivery(row, lockedAt, 0);
	}

	async completeDelivery(
		command: CompleteCompletionDeliveryCommand
	): Promise<CompleteCompletionDeliveryResult> {
		const rows = await this.#sql<{ id: string }[]>`
			UPDATE completion_delivery_outbox
			SET status = 'delivered', claim_token = NULL, locked_at = NULL, retryable = false,
				sealed_token = NULL, delivered_at = ${command.deliveredAt}::timestamptz,
				provider_message_id = ${command.providerMessageId},
				updated_at = ${command.deliveredAt}::timestamptz
			WHERE id = ${command.deliveryId}
				AND status = 'processing' AND claim_token = ${command.claimToken}
			RETURNING id`;
		return rows.length === 1 ? { outcome: 'completed' } : { outcome: 'stale' };
	}

	async failDelivery(
		command: FailCompletionDeliveryCommand
	): Promise<FailCompletionDeliveryResult> {
		const rows = command.retryable
			? await this.#sql<{ id: string }[]>`
					UPDATE completion_delivery_outbox
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = true,
						available_at = ${command.nextAvailableAt}::timestamptz, last_error = ${command.errorCode},
						updated_at = ${command.failedAt}::timestamptz
					WHERE id = ${command.deliveryId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING id`
			: await this.#sql<{ id: string }[]>`
					UPDATE completion_delivery_outbox
					SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = false,
						sealed_token = NULL,
						access_revoked_at = COALESCE(access_revoked_at, ${command.failedAt}::timestamptz),
						available_at = ${command.nextAvailableAt}::timestamptz,
						last_error = ${command.errorCode}, updated_at = ${command.failedAt}::timestamptz
					WHERE id = ${command.deliveryId}
						AND status = 'processing' AND claim_token = ${command.claimToken}
					RETURNING id`;
		return rows.length === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}

	async resolveArtifactLocatorByTokenHash(
		tokenHash: string,
		at: string
	): Promise<CompletionArtifactLocator | null> {
		const rows = await this.#sql<ArtifactLocatorRow[]>`
			SELECT
				artifact.envelope_id AS "envelopeId",
				artifact.json_object_key AS "jsonObjectKey",
				artifact.json_sha256 AS "jsonSha256",
				artifact.markdown_object_key AS "markdownObjectKey",
				artifact.markdown_sha256 AS "markdownSha256"
			FROM completion_delivery_outbox delivery
			INNER JOIN envelope
				ON envelope.id = delivery.envelope_id
			INNER JOIN completion_artifact artifact
				ON artifact.envelope_id = delivery.envelope_id
			WHERE delivery.token_hash = ${tokenHash}
				AND delivery.access_revoked_at IS NULL
				AND delivery.access_expires_at > ${at}::timestamptz
				AND envelope.status = 'completed'
			LIMIT 1`;
		const row: ArtifactLocatorRow | undefined = rows[0];
		if (row === undefined) return null;
		return {
			envelopeId: row.envelopeId,
			jsonObjectKey: row.jsonObjectKey,
			jsonSha256: row.jsonSha256,
			markdownObjectKey: row.markdownObjectKey,
			markdownSha256: row.markdownSha256
		};
	}

	async findStaleSealedCompletionTokens(
		command: FindStaleSealedCompletionTokensCommand
	): Promise<readonly StaleSealedCompletionTokenRow[]> {
		const rows = await this.#sql<
			{
				deliveryId: string;
				envelopeId: string;
				recipientId: string;
				sealedToken: string;
				sealingKeyId: string;
			}[]
		>`
			SELECT id AS "deliveryId",
				envelope_id AS "envelopeId", recipient_id AS "recipientId",
				sealed_token AS "sealedToken", sealing_key_id AS "sealingKeyId"
			FROM completion_delivery_outbox
			WHERE status IN ('pending', 'failed')
				AND sealed_token IS NOT NULL
				AND sealing_key_id <> ${command.activeSealingKeyId}
			ORDER BY updated_at ASC, id ASC
			LIMIT ${command.limit}`;
		return rows.map((row): StaleSealedCompletionTokenRow => ({
			deliveryId: row.deliveryId,
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			sealedToken: row.sealedToken,
			sealingKeyId: row.sealingKeyId
		}));
	}

	async resealCompletionToken(
		command: ResealCompletionTokenCommand
	): Promise<ResealCompletionTokenResult> {
		const rows = await this.#sql<{ id: string }[]>`
			UPDATE completion_delivery_outbox
			SET sealed_token = ${command.sealedToken},
				sealing_key_id = ${command.sealingKeyId},
				sealed_token_sha256 = ${command.sealedTokenSha256},
				updated_at = ${command.updatedAt}::timestamptz
			WHERE id = ${command.deliveryId}
				AND status <> 'processing'
				AND sealed_token IS NOT NULL
				AND sealing_key_id = ${command.previousSealingKeyId}
			RETURNING id`;
		return rows.length === 1 ? { outcome: 'resealed' } : { outcome: 'stale' };
	}
}

function toClaimedDelivery(
	row: ClaimCandidateRow,
	lockedAt: string,
	attemptIncrement: number
): ClaimedCompletionDelivery {
	return {
		deliveryId: row.deliveryId,
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		status: 'processing',
		tokenHash: row.tokenHash,
		accessExpiresAt: isoTimestamp(row.accessExpiresAt),
		accessRevokedAt: isoTimestampOrNull(row.accessRevokedAt),
		sealedToken: row.sealedToken,
		sealingKeyId: row.sealingKeyId,
		sealedTokenSha256: row.sealedTokenSha256,
		availableAt: isoTimestamp(row.availableAt),
		attempts: Number(row.attempts) + attemptIncrement,
		lockedAt,
		recipientEmail: row.recipientEmail,
		recipientName: row.recipientName,
		recipientLocale: row.recipientLocale,
		recipientRole: row.recipientRole,
		envelopeTitle: row.envelopeTitle,
		envelopeStatus: row.envelopeStatus
	};
}

function isoTimestamp(value: Date | string): string {
	const parsed = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(parsed.valueOf())) {
		throw new Error('Invalid timestamp returned by PostgreSQL');
	}
	return parsed.toISOString();
}

function isoTimestampOrNull(value: Date | string | null): string | null {
	if (value === null) return null;
	return isoTimestamp(value);
}
