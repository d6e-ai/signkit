import postgres from 'postgres';
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

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

const ELIGIBLE_RECIPIENT_ROLES: ReadonlySet<string> = new Set([
	'signer',
	'approver',
	'viewer',
	'cc'
]);

interface CurrentDeliveryRow {
	deliveryId: string;
	recipientId: string;
	recipientRole: CurrentCompletionDeliveryRow['recipientRole'];
	generation: number;
	status: CurrentCompletionDeliveryRow['status'];
	attempts: number;
	accessExpiresAt: Date | string;
	accessRevokedAt: Date | string | null;
	deliveredAt: Date | string | null;
	failedAt: Date | string | null;
	errorCode: string | null;
	retryable: boolean;
	claimToken: string | null;
	lockedAt: Date | string | null;
	sealedToken: string | null;
}

interface PredecessorRow {
	status: string;
	retryable: boolean;
	accessRevokedAt: Date | string | null;
	sealedToken: string | null;
	claimToken: string | null;
	lockedAt: Date | string | null;
	attempts: number;
	updatedAt: Date | string;
	errorCode: string | null;
	generation: number;
}

interface ArtifactMatchRow {
	manifestMatch: boolean;
	pdfMatch: boolean;
}

interface AuditHeadRow {
	sequence: number | string;
	eventHash: string;
}

interface ResolveCommandRow {
	envelopeId: string;
	recipientId: string;
	predecessorDeliveryId: string;
	requestHash: string;
	newDeliveryId: string;
	newAccessExpiresAt: Date | string;
	reissuedAt: Date | string;
	auditEventId: string;
	generation: number | null;
}

export class PostgresCompletionAccessReissueStore implements CompletionAccessReissueStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async listCurrentDeliveries(
		envelopeId: string
	): Promise<readonly CurrentCompletionDeliveryRow[]> {
		const rows = await this.#sql<CurrentDeliveryRow[]>`
			SELECT delivery.id AS "deliveryId", delivery.recipient_id AS "recipientId",
				recipient.role AS "recipientRole", delivery.generation AS "generation",
				delivery.status AS "status", delivery.attempts AS "attempts",
				delivery.access_expires_at AS "accessExpiresAt",
				delivery.access_revoked_at AS "accessRevokedAt",
				delivery.delivered_at AS "deliveredAt",
				CASE WHEN delivery.status = 'failed' THEN delivery.updated_at END AS "failedAt",
				delivery.last_error AS "errorCode", delivery.retryable AS "retryable",
				delivery.claim_token AS "claimToken", delivery.locked_at AS "lockedAt",
				delivery.sealed_token AS "sealedToken"
			FROM completion_delivery_outbox delivery
			INNER JOIN recipient ON recipient.id = delivery.recipient_id
				AND recipient.envelope_id = delivery.envelope_id
			WHERE delivery.envelope_id = ${envelopeId}
				AND delivery.generation = (
					SELECT MAX(successor.generation) FROM completion_delivery_outbox successor
					WHERE successor.envelope_id = delivery.envelope_id
						AND successor.recipient_id = delivery.recipient_id
				)
			ORDER BY recipient.routing_order ASC, recipient.id ASC`;
		return rows.map(toCurrentCompletionDeliveryRow);
	}

	async prepareReissue(
		key: ReissueCommandKey,
		expected: ExpectedPredecessorGeneration
	): Promise<CompletionAccessReissuePreparationOutcome> {
		const replay: ReissueReplayOutcome | null = await this.#resolveCommand(this.#sql, key);
		if (replay !== null) return replay;
		return await this.#evaluateEligibility(this.#sql, key, expected, false);
	}

	async publishReissue(
		command: PublishCompletionAccessReissueCommand
	): Promise<PublishCompletionAccessReissueOutcome> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<PublishCompletionAccessReissueOutcome> => {
					// Lock the envelope before the predecessor: every other writer of
					// this envelope's audit chain (artifact publication/repair, other
					// reissues) takes the same envelope-first lock, so holding it here
					// serializes against a concurrent repair or a racing duplicate.
					const replay: ReissueReplayOutcome | null = await this.#resolveCommand(
						transaction,
						command
					);
					if (replay !== null) return replay;

					const preparation: CompletionAccessReissuePreparationOutcome =
						await this.#evaluateEligibility(transaction, command, command, true);
					if (preparation.outcome !== 'ready') {
						return publishOutcomeFromPreparation(preparation);
					}
					if (
						preparation.auditHead === undefined ||
						preparation.predecessorGeneration === undefined ||
						preparation.auditHead.sequence !== command.expectedAuditSequence ||
						preparation.auditHead.eventHash !== command.previousAuditHash
					) {
						return { outcome: 'integrity_error' };
					}

					const artifact: ArtifactMatchRow = await this.#readArtifactMatch(transaction, command);
					if (!artifact.manifestMatch || !artifact.pdfMatch) {
						return { outcome: 'integrity_error' };
					}

					const newGeneration: number = preparation.predecessorGeneration + 1;
					await transaction`
						INSERT INTO completion_delivery_outbox (
							id, envelope_id, recipient_id, status, token_hash, access_expires_at,
							access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
							available_at, attempts, locked_at, claim_token, delivered_at,
							provider_message_id, last_error, retryable, created_at, updated_at,
							generation, predecessor_delivery_id, failure_cause_code
						) VALUES (
							${command.newDeliveryId}, ${command.envelopeId}, ${command.recipientId},
							'pending', ${command.newTokenHash}, ${command.newAccessExpiresAt}::timestamptz,
							NULL, ${command.sealedToken}, ${command.sealingKeyId}, ${command.sealedTokenSha256},
							${command.reissuedAt}::timestamptz, 0, NULL, NULL, NULL, NULL, NULL, true,
							${command.reissuedAt}::timestamptz, ${command.reissuedAt}::timestamptz,
							${newGeneration}, ${command.predecessorDeliveryId}, NULL
						)`;

					await transaction`
						INSERT INTO completion_access_reissue_command (
							envelope_id, recipient_id, predecessor_delivery_id, actor_type, actor_id,
							idempotency_key, request_hash, expected_attempts, expected_failed_at,
							expected_error_code, expected_json_sha256, expected_markdown_sha256,
							expected_pdf_sha256, new_delivery_id, new_access_expires_at, reissued_at,
							audit_event_id, audit_sequence, previous_audit_hash, audit_event_hash,
							audit_payload_json
						) VALUES (
							${command.envelopeId}, ${command.recipientId}, ${command.predecessorDeliveryId},
							${command.actorType}, ${command.actorId}, ${command.idempotencyKey},
							${command.requestHash}, ${command.expectedAttempts},
							${command.expectedFailedAt}::timestamptz, ${command.expectedErrorCode},
							${command.expectedJsonSha256}, ${command.expectedMarkdownSha256},
							${command.expectedPdfSha256}, ${command.newDeliveryId},
							${command.newAccessExpiresAt}::timestamptz, ${command.reissuedAt}::timestamptz,
							${command.auditEventId}, ${command.expectedAuditSequence + 1},
							${command.previousAuditHash}, ${command.auditEventHash}, ${command.auditPayloadJson}
						)`;

					await transaction`
						INSERT INTO audit_event (
							id, envelope_id, sequence, event_type, actor_type,
							actor_id, payload_json, previous_hash, event_hash, occurred_at
						) VALUES (
							${command.auditEventId}, ${command.envelopeId},
							${command.expectedAuditSequence + 1}, 'recipient.completion_access_reissued',
							${command.actorType}, ${command.actorId}, ${command.auditPayloadJson},
							${command.previousAuditHash}, ${command.auditEventHash},
							${command.reissuedAt}::timestamptz
						)`;

					await transaction`
						UPDATE envelope SET updated_at = ${command.reissuedAt}::timestamptz
						WHERE id = ${command.envelopeId}`;

					return {
						outcome: 'published',
						result: {
							envelopeId: command.envelopeId,
							recipientId: command.recipientId,
							deliveryId: command.newDeliveryId,
							generation: newGeneration,
							accessExpiresAt: command.newAccessExpiresAt,
							reissuedAt: command.reissuedAt,
							auditEventId: command.auditEventId
						}
					};
				}
			);
		} catch (error: unknown) {
			// Never classified from provider-specific error text -- only from
			// durable evidence read back below (a concurrent duplicate that raced
			// this one to a unique-constraint violation, for example, is a replay).
			const classified: ReissueReplayOutcome | null = await this.#resolveCommand(
				this.#sql,
				command
			);
			if (classified !== null) return classified;
			throw error;
		}
	}

	async #evaluateEligibility(
		sql: Sql,
		key: ReissueCommandKey,
		expected: ExpectedPredecessorGeneration,
		lock: boolean
	): Promise<CompletionAccessReissuePreparationOutcome> {
		const envelopeStatus: string | null = await this.#readEnvelopeStatus(sql, key.envelopeId, lock);
		if (envelopeStatus === null) return { outcome: 'not_found' };
		if (envelopeStatus !== 'completed') {
			return { outcome: 'not_eligible', notEligibleReason: 'envelope_not_completed' };
		}

		const recipientRole: string | null = await this.#readRecipientRole(
			sql,
			key.envelopeId,
			key.recipientId,
			lock
		);
		if (recipientRole === null) return { outcome: 'not_found' };
		if (!ELIGIBLE_RECIPIENT_ROLES.has(recipientRole)) {
			return { outcome: 'not_eligible', notEligibleReason: 'recipient_not_eligible' };
		}

		const predecessor: PredecessorRow | null = await this.#readPredecessor(
			sql,
			key.envelopeId,
			key.recipientId,
			key.predecessorDeliveryId,
			lock
		);
		if (predecessor === null) return { outcome: 'not_found' };

		const hasSuccessor: boolean = await this.#hasSuccessor(sql, key.predecessorDeliveryId);
		if (hasSuccessor) return { outcome: 'stale_generation' };

		const exhausted: boolean =
			predecessor.status === 'failed' &&
			!predecessor.retryable &&
			predecessor.accessRevokedAt !== null &&
			predecessor.sealedToken === null &&
			predecessor.claimToken === null &&
			predecessor.lockedAt === null;
		if (!exhausted) {
			return { outcome: 'not_eligible', notEligibleReason: 'predecessor_not_exhausted' };
		}

		if (
			predecessor.attempts !== expected.expectedAttempts ||
			isoTimestamp(predecessor.updatedAt) !== expected.expectedFailedAt ||
			predecessor.errorCode !== expected.expectedErrorCode
		) {
			return { outcome: 'stale_generation' };
		}

		const auditHead: ReissueAuditHead | null = await this.#readAuditHead(sql, key.envelopeId);
		if (auditHead === null) return { outcome: 'integrity_error' };

		return { outcome: 'ready', predecessorGeneration: predecessor.generation, auditHead };
	}

	async #readEnvelopeStatus(sql: Sql, envelopeId: string, lock: boolean): Promise<string | null> {
		const rows = lock
			? await sql<{ status: string }[]>`
				SELECT status FROM envelope WHERE id = ${envelopeId} FOR UPDATE`
			: await sql<{ status: string }[]>`
				SELECT status FROM envelope WHERE id = ${envelopeId} LIMIT 1`;
		return rows[0]?.status ?? null;
	}

	async #readRecipientRole(
		sql: Sql,
		envelopeId: string,
		recipientId: string,
		lock: boolean
	): Promise<string | null> {
		const rows = lock
			? await sql<{ role: string }[]>`
				SELECT role FROM recipient
				WHERE envelope_id = ${envelopeId} AND id = ${recipientId}
				FOR UPDATE`
			: await sql<{ role: string }[]>`
				SELECT role FROM recipient
				WHERE envelope_id = ${envelopeId} AND id = ${recipientId}
				LIMIT 1`;
		return rows[0]?.role ?? null;
	}

	async #readPredecessor(
		sql: Sql,
		envelopeId: string,
		recipientId: string,
		predecessorDeliveryId: string,
		lock: boolean
	): Promise<PredecessorRow | null> {
		const rows = lock
			? await sql<PredecessorRow[]>`
				SELECT status, retryable, access_revoked_at AS "accessRevokedAt",
					sealed_token AS "sealedToken", claim_token AS "claimToken",
					locked_at AS "lockedAt", attempts, updated_at AS "updatedAt",
					last_error AS "errorCode", generation
				FROM completion_delivery_outbox
				WHERE id = ${predecessorDeliveryId} AND envelope_id = ${envelopeId}
					AND recipient_id = ${recipientId}
				FOR UPDATE`
			: await sql<PredecessorRow[]>`
				SELECT status, retryable, access_revoked_at AS "accessRevokedAt",
					sealed_token AS "sealedToken", claim_token AS "claimToken",
					locked_at AS "lockedAt", attempts, updated_at AS "updatedAt",
					last_error AS "errorCode", generation
				FROM completion_delivery_outbox
				WHERE id = ${predecessorDeliveryId} AND envelope_id = ${envelopeId}
					AND recipient_id = ${recipientId}`;
		return rows[0] ?? null;
	}

	async #hasSuccessor(sql: Sql, predecessorDeliveryId: string): Promise<boolean> {
		const rows = await sql<{ exists: boolean }[]>`
			SELECT EXISTS (
				SELECT 1 FROM completion_delivery_outbox
				WHERE predecessor_delivery_id = ${predecessorDeliveryId}
			) AS "exists"`;
		return rows[0]?.exists === true;
	}

	async #readArtifactMatch(
		sql: Sql,
		command: PublishCompletionAccessReissueCommand
	): Promise<ArtifactMatchRow> {
		const rows = await sql<ArtifactMatchRow[]>`
			SELECT
				EXISTS (
					SELECT 1 FROM completion_artifact
					WHERE envelope_id = ${command.envelopeId}
						AND json_sha256 = ${command.expectedJsonSha256}
						AND markdown_sha256 = ${command.expectedMarkdownSha256}
				) AS "manifestMatch",
				EXISTS (
					SELECT 1 FROM completion_artifact_pdf
					WHERE envelope_id = ${command.envelopeId}
						AND pdf_sha256 = ${command.expectedPdfSha256}
				) AS "pdfMatch"`;
		return rows[0] ?? { manifestMatch: false, pdfMatch: false };
	}

	async #readAuditHead(sql: Sql, envelopeId: string): Promise<ReissueAuditHead | null> {
		const rows = await sql<AuditHeadRow[]>`
			SELECT sequence, event_hash AS "eventHash"
			FROM audit_event
			WHERE envelope_id = ${envelopeId}
			ORDER BY sequence DESC
			LIMIT 1`;
		const row = rows[0];
		if (row === undefined) return null;
		const sequence = Number(row.sequence);
		if (!Number.isSafeInteger(sequence) || sequence < 1 || row.eventHash.length === 0) return null;
		return { sequence, eventHash: row.eventHash };
	}

	async #resolveCommand(sql: Sql, key: ReissueCommandKey): Promise<ReissueReplayOutcome | null> {
		const rows = await sql<ResolveCommandRow[]>`
			SELECT command.envelope_id AS "envelopeId", command.recipient_id AS "recipientId",
				command.predecessor_delivery_id AS "predecessorDeliveryId",
				command.request_hash AS "requestHash", command.new_delivery_id AS "newDeliveryId",
				command.new_access_expires_at AS "newAccessExpiresAt",
				command.reissued_at AS "reissuedAt", command.audit_event_id AS "auditEventId",
				outbox.generation AS "generation"
			FROM completion_access_reissue_command command
			LEFT JOIN completion_delivery_outbox outbox ON outbox.id = command.new_delivery_id
			WHERE command.actor_type = ${key.actorType} AND command.actor_id = ${key.actorId}
				AND command.idempotency_key = ${key.idempotencyKey}
			LIMIT 1`;
		const row = rows[0];
		if (row === undefined) return null;
		if (
			row.envelopeId !== key.envelopeId ||
			row.recipientId !== key.recipientId ||
			row.predecessorDeliveryId !== key.predecessorDeliveryId ||
			row.requestHash !== key.requestHash
		) {
			return { outcome: 'idempotency_conflict' };
		}
		if (row.generation === null || !Number.isSafeInteger(row.generation)) {
			throw new Error('Completion access reissue command receipt is inconsistent');
		}
		return {
			outcome: 'replayed',
			result: {
				envelopeId: row.envelopeId,
				recipientId: row.recipientId,
				deliveryId: row.newDeliveryId,
				generation: row.generation,
				accessExpiresAt: isoTimestamp(row.newAccessExpiresAt),
				reissuedAt: isoTimestamp(row.reissuedAt),
				auditEventId: row.auditEventId
			}
		};
	}
}

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCurrentCompletionDeliveryRow(row: CurrentDeliveryRow): CurrentCompletionDeliveryRow {
	return {
		deliveryId: row.deliveryId,
		recipientId: row.recipientId,
		recipientRole: row.recipientRole,
		generation: row.generation,
		status: row.status,
		attempts: row.attempts,
		accessExpiresAt: isoTimestamp(row.accessExpiresAt),
		accessRevokedAt: row.accessRevokedAt === null ? null : isoTimestamp(row.accessRevokedAt),
		deliveredAt: row.deliveredAt === null ? null : isoTimestamp(row.deliveredAt),
		failedAt: row.failedAt === null ? null : isoTimestamp(row.failedAt),
		errorCode: row.errorCode,
		eligibleForReissue:
			row.status === 'failed' &&
			!row.retryable &&
			row.accessRevokedAt !== null &&
			row.sealedToken === null &&
			row.claimToken === null &&
			row.lockedAt === null
	};
}
