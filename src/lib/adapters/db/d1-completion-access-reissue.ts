import type {
	CompletionAccessReissuePreparationOutcome,
	CompletionAccessReissueStore,
	ExpectedPredecessorGeneration,
	PublishCompletionAccessReissueCommand,
	PublishCompletionAccessReissueOutcome,
	ReissueAuditHead,
	ReissueCommandKey,
	ReissueReplayOutcome
} from '$lib/ports/completion-access-reissue';
import { publishOutcomeFromPreparation } from '$lib/ports/completion-access-reissue';
import type { CurrentCompletionDeliveryRow } from '$lib/ports/completion-access-reissue-row';

const ELIGIBLE_RECIPIENT_ROLES: ReadonlySet<string> = new Set([
	'signer',
	'approver',
	'viewer',
	'cc'
]);

interface CurrentDeliveryRawRow {
	delivery_id: string;
	recipient_id: string;
	recipient_role: CurrentCompletionDeliveryRow['recipientRole'];
	generation: number;
	status: CurrentCompletionDeliveryRow['status'];
	attempts: number;
	access_expires_at: string;
	access_revoked_at: string | null;
	delivered_at: string | null;
	failed_at: string | null;
	error_code: string | null;
	retryable: number;
	claim_token: string | null;
	locked_at: string | null;
	sealed_token: string | null;
}

interface ResolveCommandRow {
	envelope_id: string;
	recipient_id: string;
	predecessor_delivery_id: string;
	request_hash: string;
	new_delivery_id: string;
	new_access_expires_at: string;
	reissued_at: string;
	audit_event_id: string;
	generation: number | null;
}

const LIST_CURRENT_DELIVERIES_QUERY: string = `SELECT delivery.id AS delivery_id,
	delivery.recipient_id AS recipient_id, recipient.role AS recipient_role,
	delivery.generation AS generation, delivery.status AS status,
	delivery.attempts AS attempts, delivery.access_expires_at AS access_expires_at,
	delivery.access_revoked_at AS access_revoked_at, delivery.delivered_at AS delivered_at,
	CASE WHEN delivery.status = 'failed' THEN delivery.updated_at END AS failed_at,
	delivery.last_error AS error_code, delivery.retryable AS retryable,
	delivery.claim_token AS claim_token, delivery.locked_at AS locked_at,
	delivery.sealed_token AS sealed_token
	FROM completion_delivery_outbox delivery
	INNER JOIN recipient ON recipient.id = delivery.recipient_id
		AND recipient.envelope_id = delivery.envelope_id
	WHERE delivery.envelope_id = ?
		AND delivery.generation = (
			SELECT MAX(successor.generation) FROM completion_delivery_outbox successor
			WHERE successor.envelope_id = delivery.envelope_id
				AND successor.recipient_id = delivery.recipient_id
		)
	ORDER BY recipient.routing_order ASC, recipient.id ASC`;

const ELIGIBILITY_QUERY: string = `SELECT
	envelope.status AS envelope_status, recipient.role AS recipient_role,
	predecessor.status AS status, predecessor.retryable AS retryable,
	predecessor.access_revoked_at AS access_revoked_at, predecessor.sealed_token AS sealed_token,
	predecessor.claim_token AS claim_token, predecessor.locked_at AS locked_at,
	predecessor.attempts AS attempts, predecessor.updated_at AS updated_at,
	predecessor.last_error AS error_code, predecessor.generation AS generation,
	EXISTS (
		SELECT 1 FROM completion_delivery_outbox successor
		WHERE successor.predecessor_delivery_id = predecessor.id
	) AS has_successor
	FROM envelope
	LEFT JOIN recipient ON recipient.envelope_id = envelope.id AND recipient.id = ?
	LEFT JOIN completion_delivery_outbox predecessor
		ON predecessor.id = ? AND predecessor.envelope_id = envelope.id
			AND predecessor.recipient_id = recipient.id
	WHERE envelope.id = ?`;

const RESOLVE_COMMAND_QUERY: string = `SELECT envelope_id, recipient_id, predecessor_delivery_id,
	request_hash, new_delivery_id, new_access_expires_at, reissued_at, audit_event_id,
	(SELECT outbox.generation FROM completion_delivery_outbox outbox
		WHERE outbox.id = completion_access_reissue_command.new_delivery_id) AS generation
	FROM completion_access_reissue_command
	WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?
	LIMIT 1`;

const PUBLISH_COMMAND: string = `INSERT INTO completion_access_reissue_command (
	envelope_id, recipient_id, predecessor_delivery_id, actor_type, actor_id,
	idempotency_key, request_hash, expected_attempts, expected_failed_at, expected_error_code,
	expected_json_sha256, expected_markdown_sha256, expected_pdf_sha256,
	new_delivery_id, new_token_hash, new_access_expires_at, sealed_token, sealing_key_id,
	sealed_token_sha256, reissued_at, audit_event_id, audit_sequence, previous_audit_hash,
	audit_event_hash, audit_payload_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface EligibilityRow {
	envelope_status: string | null;
	recipient_role: string | null;
	status: string | null;
	retryable: number | null;
	access_revoked_at: string | null;
	sealed_token: string | null;
	claim_token: string | null;
	locked_at: string | null;
	attempts: number | null;
	updated_at: string | null;
	error_code: string | null;
	generation: number | null;
	has_successor: number;
}

export class D1CompletionAccessReissueStore implements CompletionAccessReissueStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async listCurrentDeliveries(
		envelopeId: string
	): Promise<readonly CurrentCompletionDeliveryRow[]> {
		const result = await this.#database
			.prepare(LIST_CURRENT_DELIVERIES_QUERY)
			.bind(envelopeId)
			.all<CurrentDeliveryRawRow>();
		return (result.results ?? []).map(toCurrentCompletionDeliveryRow);
	}

	async prepareReissue(
		key: ReissueCommandKey,
		expected: ExpectedPredecessorGeneration
	): Promise<CompletionAccessReissuePreparationOutcome> {
		const replay: ReissueReplayOutcome | null = await this.#resolveCommand(key);
		if (replay !== null) return replay;

		const row: EligibilityRow | null = await this.#database
			.prepare(ELIGIBILITY_QUERY)
			.bind(key.recipientId, key.predecessorDeliveryId, key.envelopeId)
			.first<EligibilityRow>();
		if (row === null || row.envelope_status === null) return { outcome: 'not_found' };
		if (row.envelope_status !== 'completed') {
			return { outcome: 'not_eligible', notEligibleReason: 'envelope_not_completed' };
		}
		if (row.recipient_role === null) return { outcome: 'not_found' };
		if (!ELIGIBLE_RECIPIENT_ROLES.has(row.recipient_role)) {
			return { outcome: 'not_eligible', notEligibleReason: 'recipient_not_eligible' };
		}
		if (row.status === null) return { outcome: 'not_found' };
		if (row.has_successor === 1) return { outcome: 'stale_generation' };

		const exhausted: boolean =
			row.status === 'failed' &&
			row.retryable === 0 &&
			row.access_revoked_at !== null &&
			row.sealed_token === null &&
			row.claim_token === null &&
			row.locked_at === null;
		if (!exhausted) {
			return { outcome: 'not_eligible', notEligibleReason: 'predecessor_not_exhausted' };
		}
		if (
			row.attempts !== expected.expectedAttempts ||
			row.updated_at !== expected.expectedFailedAt ||
			row.error_code !== expected.expectedErrorCode
		) {
			return { outcome: 'stale_generation' };
		}

		const auditHead: ReissueAuditHead | null = await this.#readAuditHead(key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };

		return {
			outcome: 'ready',
			predecessorGeneration: row.generation ?? 0,
			auditHead
		};
	}

	async publishReissue(
		command: PublishCompletionAccessReissueCommand
	): Promise<PublishCompletionAccessReissueOutcome> {
		const statement: D1PreparedStatement = this.#database
			.prepare(PUBLISH_COMMAND)
			.bind(
				command.envelopeId,
				command.recipientId,
				command.predecessorDeliveryId,
				command.actorType,
				command.actorId,
				command.idempotencyKey,
				command.requestHash,
				command.expectedAttempts,
				command.expectedFailedAt,
				command.expectedErrorCode,
				command.expectedJsonSha256,
				command.expectedMarkdownSha256,
				command.expectedPdfSha256,
				command.newDeliveryId,
				command.newTokenHash,
				command.newAccessExpiresAt,
				command.sealedToken,
				command.sealingKeyId,
				command.sealedTokenSha256,
				command.reissuedAt,
				command.auditEventId,
				command.expectedAuditSequence + 1,
				command.previousAuditHash,
				command.auditEventHash,
				command.auditPayloadJson
			);

		try {
			await this.#database.batch([statement]);
		} catch {
			// D1 exposes provider-specific text for the trigger's `RAISE(ABORT, ...)`
			// predicates. Never classified from that message -- only from durable
			// evidence read back below.
			return await this.#classifyPublishFailure(command);
		}

		const published: { generation: number } | null = await this.#database
			.prepare('SELECT generation FROM completion_delivery_outbox WHERE id = ?')
			.bind(command.newDeliveryId)
			.first<{ generation: number }>();
		if (published === null) {
			throw new Error('Completion access reissue publication is inconsistent');
		}

		return {
			outcome: 'published',
			result: {
				envelopeId: command.envelopeId,
				recipientId: command.recipientId,
				deliveryId: command.newDeliveryId,
				generation: published.generation,
				accessExpiresAt: command.newAccessExpiresAt,
				reissuedAt: command.reissuedAt,
				auditEventId: command.auditEventId
			}
		};
	}

	async #classifyPublishFailure(
		command: PublishCompletionAccessReissueCommand
	): Promise<PublishCompletionAccessReissueOutcome> {
		const replay: ReissueReplayOutcome | null = await this.#resolveCommand(command);
		if (replay !== null) return replay;

		const preparation: CompletionAccessReissuePreparationOutcome = await this.prepareReissue(
			command,
			command
		);
		// Every read-side predicate this process can observe still passing while
		// the write itself aborted means only the trigger's write-time-only
		// predicates (the audit head, or the completion manifest/PDF digests
		// re-checked against `completion_artifact` / `completion_artifact_pdf`)
		// can explain it -- `publishOutcomeFromPreparation` maps that `'ready'`
		// case to `integrity_error` rather than a silent success.
		return publishOutcomeFromPreparation(preparation);
	}

	async #readAuditHead(envelopeId: string): Promise<ReissueAuditHead | null> {
		const row = await this.#database
			.prepare(
				`SELECT sequence, event_hash FROM audit_event
				 WHERE envelope_id = ?
				 ORDER BY sequence DESC
				 LIMIT 1`
			)
			.bind(envelopeId)
			.first<{ sequence: number; event_hash: string }>();
		if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return null;
		if (row.event_hash.length === 0) return null;
		return { sequence: row.sequence, eventHash: row.event_hash };
	}

	async #resolveCommand(key: ReissueCommandKey): Promise<ReissueReplayOutcome | null> {
		const row: ResolveCommandRow | null = await this.#database
			.prepare(RESOLVE_COMMAND_QUERY)
			.bind(key.actorType, key.actorId, key.idempotencyKey)
			.first<ResolveCommandRow>();
		if (row === null) return null;
		if (
			row.envelope_id !== key.envelopeId ||
			row.recipient_id !== key.recipientId ||
			row.predecessor_delivery_id !== key.predecessorDeliveryId ||
			row.request_hash !== key.requestHash
		) {
			return { outcome: 'idempotency_conflict' };
		}
		if (row.generation === null || !Number.isSafeInteger(row.generation)) {
			throw new Error('Completion access reissue command receipt is inconsistent');
		}
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelope_id,
				recipientId: row.recipient_id,
				deliveryId: row.new_delivery_id,
				generation: row.generation,
				accessExpiresAt: row.new_access_expires_at,
				reissuedAt: row.reissued_at,
				auditEventId: row.audit_event_id
			}
		};
	}
}

function toCurrentCompletionDeliveryRow(row: CurrentDeliveryRawRow): CurrentCompletionDeliveryRow {
	return {
		deliveryId: row.delivery_id,
		recipientId: row.recipient_id,
		recipientRole: row.recipient_role,
		generation: row.generation,
		status: row.status,
		attempts: row.attempts,
		accessExpiresAt: row.access_expires_at,
		accessRevokedAt: row.access_revoked_at,
		deliveredAt: row.delivered_at,
		failedAt: row.failed_at,
		errorCode: row.error_code,
		eligibleForReissue:
			row.status === 'failed' &&
			row.retryable === 0 &&
			row.access_revoked_at !== null &&
			row.sealed_token === null &&
			row.claim_token === null &&
			row.locked_at === null
	};
}
