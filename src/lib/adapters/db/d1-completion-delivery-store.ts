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

const CLAIM_CANDIDATE_COLUMNS: string = `delivery.id AS delivery_id,
	delivery.organization_id AS organization_id,
	delivery.envelope_id AS envelope_id,
	delivery.recipient_id AS recipient_id,
	delivery.token_hash AS token_hash,
	delivery.access_expires_at AS access_expires_at,
	delivery.access_revoked_at AS access_revoked_at,
	delivery.sealed_token AS sealed_token,
	delivery.sealing_key_id AS sealing_key_id,
	delivery.sealed_token_sha256 AS sealed_token_sha256,
	delivery.available_at AS available_at,
	delivery.attempts AS attempts,
	delivery.locked_at AS locked_at,
	recipient.email AS recipient_email,
	recipient.name AS recipient_name,
	recipient.locale AS recipient_locale,
	recipient.role AS recipient_role,
	envelope.title AS envelope_title,
	envelope.status AS envelope_status`;

const CLAIM_CANDIDATE_JOIN: string = `FROM completion_delivery_outbox delivery
	INNER JOIN recipient
		ON recipient.organization_id = delivery.organization_id
		AND recipient.id = delivery.recipient_id
		AND recipient.envelope_id = delivery.envelope_id
	INNER JOIN envelope
		ON envelope.organization_id = delivery.organization_id
		AND envelope.id = delivery.envelope_id
	INNER JOIN completion_artifact artifact
		ON artifact.organization_id = delivery.organization_id
		AND artifact.envelope_id = delivery.envelope_id
	WHERE (
			(delivery.status IN ('pending', 'failed') AND delivery.retryable = 1 AND delivery.available_at <= ?)
			OR (delivery.status = 'processing' AND delivery.locked_at < ?)
		)
		AND envelope.status = 'completed'
		AND recipient.role IN ('signer', 'approver', 'viewer', 'cc')
		AND delivery.access_revoked_at IS NULL
		AND julianday(delivery.access_expires_at) > julianday(?)
		AND delivery.sealed_token IS NOT NULL`;

const READ_CLAIMED_DELIVERY_QUERY: string = `SELECT ${CLAIM_CANDIDATE_COLUMNS}
	FROM completion_delivery_outbox delivery
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
	FROM completion_delivery_outbox delivery
	INNER JOIN recipient
		ON recipient.organization_id = delivery.organization_id
		AND recipient.id = delivery.recipient_id
		AND recipient.envelope_id = delivery.envelope_id
	INNER JOIN envelope
		ON envelope.organization_id = delivery.organization_id
		AND envelope.id = delivery.envelope_id
	WHERE delivery.retryable = 1
		AND delivery.sealed_token IS NOT NULL
		AND (
			delivery.status IN ('pending', 'failed')
			OR (delivery.status = 'processing' AND delivery.locked_at < ?)
		)
		AND NOT (
			envelope.status = 'completed'
			AND recipient.role IN ('signer', 'approver', 'viewer', 'cc')
			AND delivery.access_revoked_at IS NULL
			AND julianday(delivery.access_expires_at) > julianday(?)
		)
	ORDER BY delivery.updated_at ASC, delivery.created_at ASC, delivery.id ASC
	LIMIT ?
)
UPDATE completion_delivery_outbox
	SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 0,
		sealed_token = NULL, access_revoked_at = COALESCE(access_revoked_at, ?),
		available_at = COALESCE(available_at, ?),
		last_error = 'delivery_not_eligible', updated_at = ?
	WHERE rowid IN (SELECT rowid FROM terminal_candidates)`;

const RESOLVE_ARTIFACT_LOCATOR_QUERY: string = `SELECT artifact.organization_id AS organization_id,
	artifact.envelope_id AS envelope_id,
	artifact.json_object_key AS json_object_key,
	artifact.json_sha256 AS json_sha256,
	artifact.markdown_object_key AS markdown_object_key,
	artifact.markdown_sha256 AS markdown_sha256
FROM completion_delivery_outbox delivery
INNER JOIN envelope
	ON envelope.organization_id = delivery.organization_id
	AND envelope.id = delivery.envelope_id
INNER JOIN completion_artifact artifact
	ON artifact.organization_id = delivery.organization_id
	AND artifact.envelope_id = delivery.envelope_id
WHERE delivery.token_hash = ?
	AND delivery.access_revoked_at IS NULL
	AND julianday(delivery.access_expires_at) > julianday(?)
	AND envelope.status = 'completed'
LIMIT 1`;

interface ArtifactLocatorRow {
	organization_id: string;
	envelope_id: string;
	json_object_key: string;
	json_sha256: string;
	markdown_object_key: string;
	markdown_sha256: string;
}

interface ClaimCandidateRow {
	delivery_id: string;
	organization_id: string;
	envelope_id: string;
	recipient_id: string;
	token_hash: string;
	access_expires_at: string;
	access_revoked_at: string | null;
	sealed_token: string | null;
	sealing_key_id: string;
	sealed_token_sha256: string;
	available_at: string;
	attempts: number;
	locked_at: string | null;
	recipient_email: string;
	recipient_name: string;
	recipient_locale: RecipientLocale;
	recipient_role: EligibleRecipientRole;
	envelope_title: string;
	envelope_status: EnvelopeStatus;
}

interface DiscoverRecipientRow {
	organization_id: string;
	envelope_id: string;
	recipient_id: string;
	recipient_email: string;
	recipient_name: string;
	recipient_locale: RecipientLocale;
	recipient_role: EligibleRecipientRole;
	envelope_title: string;
}

export class D1CompletionDeliveryStore implements CompletionDeliveryStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async discoverEligibleRecipients(
		limit: number
	): Promise<readonly EligibleCompletionDeliveryRecipient[]> {
		const result: D1Result<DiscoverRecipientRow> = await this.#database
			.prepare(
				`SELECT recipient.organization_id AS organization_id,
					recipient.envelope_id AS envelope_id,
					recipient.id AS recipient_id,
					recipient.email AS recipient_email,
					recipient.name AS recipient_name,
					recipient.locale AS recipient_locale,
					recipient.role AS recipient_role,
					envelope.title AS envelope_title
				FROM recipient
				INNER JOIN envelope
					ON envelope.organization_id = recipient.organization_id
					AND envelope.id = recipient.envelope_id
				INNER JOIN completion_artifact artifact
					ON artifact.organization_id = recipient.organization_id
					AND artifact.envelope_id = recipient.envelope_id
				WHERE envelope.status = 'completed'
					AND recipient.role IN ('signer', 'approver', 'viewer', 'cc')
					AND NOT EXISTS (
						SELECT 1 FROM completion_delivery_outbox outbox
						WHERE outbox.organization_id = recipient.organization_id
							AND outbox.envelope_id = recipient.envelope_id
							AND outbox.recipient_id = recipient.id
					)
				ORDER BY envelope.updated_at ASC, recipient.routing_order ASC, recipient.id ASC
				LIMIT ?`
			)
			.bind(limit)
			.all<DiscoverRecipientRow>();

		const rows: readonly DiscoverRecipientRow[] = result.results ?? [];
		return rows.map((row: DiscoverRecipientRow): EligibleCompletionDeliveryRecipient => ({
			organizationId: row.organization_id,
			envelopeId: row.envelope_id,
			recipientId: row.recipient_id,
			recipientEmail: row.recipient_email,
			recipientName: row.recipient_name,
			recipientLocale: row.recipient_locale,
			recipientRole: row.recipient_role,
			envelopeTitle: row.envelope_title
		}));
	}

	async enrollDeliveries(items: readonly EnrollCompletionDeliveryItem[]): Promise<number> {
		if (items.length === 0) return 0;
		const statements: D1PreparedStatement[] = items.map((item) =>
			this.#database
				.prepare(
					`INSERT INTO completion_delivery_outbox (
						id, organization_id, envelope_id, recipient_id, status, token_hash,
						access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
						sealed_token_sha256, available_at, attempts, locked_at, claim_token,
						delivered_at, provider_message_id, last_error, retryable, created_at, updated_at
					) VALUES (
						?, ?, ?, ?, 'pending', ?,
						?, NULL, ?, ?,
						?, ?, 0, NULL, NULL,
						NULL, NULL, NULL, 1, ?, ?
					)
					ON CONFLICT (organization_id, envelope_id, recipient_id) DO NOTHING`
				)
				.bind(
					item.id,
					item.organizationId,
					item.envelopeId,
					item.recipientId,
					item.tokenHash,
					item.accessExpiresAt,
					item.sealedToken,
					item.sealingKeyId,
					item.sealedTokenSha256,
					item.availableAt,
					item.createdAt,
					item.createdAt
				)
		);
		const results: D1Result[] = await this.#database.batch(statements);
		let insertedCount = 0;
		for (const res of results) {
			if (res.meta.changes > 0) insertedCount += res.meta.changes;
		}
		return insertedCount;
	}

	async claimPendingDeliveries(
		command: ClaimCompletionDeliveriesCommand
	): Promise<readonly ClaimedCompletionDelivery[]> {
		const cleanup: D1PreparedStatement = this.#database
			.prepare(D1_TERMINAL_CLEANUP_QUERY)
			.bind(
				command.staleBefore,
				command.claimedAt,
				MAX_COMPLETION_DELIVERY_TERMINAL_CLEANUP_BATCH,
				command.claimedAt,
				command.claimedAt,
				command.claimedAt
			);
		const claim: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE completion_delivery_outbox
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
				 FROM completion_delivery_outbox delivery
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
		const rows: readonly ClaimCandidateRow[] = (results[2].results as ClaimCandidateRow[]) ?? [];
		return rows.map(toClaimedDelivery);
	}

	async readClaimedDelivery(
		command: ReadClaimedCompletionDeliveryCommand
	): Promise<ClaimedCompletionDelivery | null> {
		const row: ClaimCandidateRow | null = await this.#database
			.prepare(READ_CLAIMED_DELIVERY_QUERY)
			.bind(command.organizationId, command.deliveryId, command.claimToken)
			.first<ClaimCandidateRow>();
		if (row === null) return null;
		return toClaimedDelivery(row);
	}

	async completeDelivery(
		command: CompleteCompletionDeliveryCommand
	): Promise<CompleteCompletionDeliveryResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE completion_delivery_outbox
				 SET status = 'delivered', claim_token = NULL, locked_at = NULL, retryable = 0,
					sealed_token = NULL, delivered_at = ?, provider_message_id = ?, updated_at = ?
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
		return result.meta.changes > 0 ? { outcome: 'completed' } : { outcome: 'stale' };
	}

	async failDelivery(
		command: FailCompletionDeliveryCommand
	): Promise<FailCompletionDeliveryResult> {
		const statement: D1PreparedStatement = command.retryable
			? this.#database
					.prepare(
						`UPDATE completion_delivery_outbox
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
			: this.#database
					.prepare(
						`UPDATE completion_delivery_outbox
						 SET status = 'failed', claim_token = NULL, locked_at = NULL, retryable = 0,
							sealed_token = NULL, access_revoked_at = COALESCE(access_revoked_at, ?),
							available_at = ?, last_error = ?, updated_at = ?
						 WHERE organization_id = ? AND id = ? AND status = 'processing' AND claim_token = ?`
					)
					.bind(
						command.failedAt,
						command.nextAvailableAt,
						command.errorCode,
						command.failedAt,
						command.organizationId,
						command.deliveryId,
						command.claimToken
					);
		const result: D1Result = await statement.run();
		return result.meta.changes > 0 ? { outcome: 'failed' } : { outcome: 'stale' };
	}

	async resolveArtifactLocatorByTokenHash(
		tokenHash: string,
		at: string
	): Promise<CompletionArtifactLocator | null> {
		const row: ArtifactLocatorRow | null = await this.#database
			.prepare(RESOLVE_ARTIFACT_LOCATOR_QUERY)
			.bind(tokenHash, at)
			.first<ArtifactLocatorRow>();
		if (row === null) return null;
		return {
			organizationId: row.organization_id,
			envelopeId: row.envelope_id,
			jsonObjectKey: row.json_object_key,
			jsonSha256: row.json_sha256,
			markdownObjectKey: row.markdown_object_key,
			markdownSha256: row.markdown_sha256
		};
	}

	async findStaleSealedCompletionTokens(
		command: FindStaleSealedCompletionTokensCommand
	): Promise<readonly StaleSealedCompletionTokenRow[]> {
		interface StaleRow {
			delivery_id: string;
			organization_id: string;
			envelope_id: string;
			recipient_id: string;
			sealed_token: string;
			sealing_key_id: string;
		}
		const result: D1Result<StaleRow> = await this.#database
			.prepare(
				`SELECT id AS delivery_id, organization_id, envelope_id, recipient_id,
					sealed_token, sealing_key_id
				 FROM completion_delivery_outbox
				 WHERE status IN ('pending', 'failed')
					AND sealed_token IS NOT NULL
					AND sealing_key_id <> ?
				 ORDER BY updated_at ASC, id ASC
				 LIMIT ?`
			)
			.bind(command.activeSealingKeyId, command.limit)
			.all<StaleRow>();
		return result.results.map((row: StaleRow): StaleSealedCompletionTokenRow => ({
			deliveryId: row.delivery_id,
			organizationId: row.organization_id,
			envelopeId: row.envelope_id,
			recipientId: row.recipient_id,
			sealedToken: row.sealed_token,
			sealingKeyId: row.sealing_key_id
		}));
	}

	async resealCompletionToken(
		command: ResealCompletionTokenCommand
	): Promise<ResealCompletionTokenResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE completion_delivery_outbox
				 SET sealed_token = ?, sealing_key_id = ?, sealed_token_sha256 = ?, updated_at = ?
				 WHERE organization_id = ? AND id = ? AND status <> 'processing'
					AND sealed_token IS NOT NULL AND sealing_key_id = ?`
			)
			.bind(
				command.sealedToken,
				command.sealingKeyId,
				command.sealedTokenSha256,
				command.updatedAt,
				command.organizationId,
				command.deliveryId,
				command.previousSealingKeyId
			)
			.run();
		return result.meta.changes > 0 ? { outcome: 'resealed' } : { outcome: 'stale' };
	}
}

function toClaimedDelivery(row: ClaimCandidateRow): ClaimedCompletionDelivery {
	return {
		deliveryId: row.delivery_id,
		organizationId: row.organization_id,
		envelopeId: row.envelope_id,
		recipientId: row.recipient_id,
		status: 'processing',
		tokenHash: row.token_hash,
		accessExpiresAt: row.access_expires_at,
		accessRevokedAt: row.access_revoked_at,
		sealedToken: row.sealed_token,
		sealingKeyId: row.sealing_key_id,
		sealedTokenSha256: row.sealed_token_sha256,
		availableAt: row.available_at,
		attempts: row.attempts,
		lockedAt: row.locked_at ?? '',
		recipientEmail: row.recipient_email,
		recipientName: row.recipient_name,
		recipientLocale: row.recipient_locale,
		recipientRole: row.recipient_role,
		envelopeTitle: row.envelope_title,
		envelopeStatus: row.envelope_status
	};
}
