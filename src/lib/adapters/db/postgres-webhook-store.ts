import postgres from 'postgres';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import {
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION
} from '$lib/security/webhook';
import {
	MAX_WEBHOOK_LIST_LIMIT,
	type ClaimWebhookDeliveriesCommand,
	type CompleteWebhookDeliveryCommand,
	type CreateWebhookEndpointCommand,
	type CreateWebhookEndpointResult,
	type FailWebhookDeliveryCommand,
	type RevokeWebhookEndpointCommand,
	type RevokeWebhookEndpointResult,
	type ResealWebhookSigningSecretCommand,
	type WebhookDeliveryLogPage,
	type WebhookEndpointMetadata,
	type WebhookListPage,
	type WebhookListQuery,
	type WebhookOutboxRow,
	type WebhookSigningSecretRow,
	type WebhookStatus,
	type WebhookStore
} from '$lib/ports/webhook-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class WebhookRollback<T> extends Error {
	constructor(readonly result: T) {
		super('Webhook transaction rolled back with an explicit outcome');
		this.name = 'WebhookRollback';
	}
}

interface EndpointRow {
	id: string;
	organizationId: string;
	url: string;
	description: string | null;
	status: string;
	eventsJson: string;
	secretPrefix: string;
	createdAt: Date | string;
	createdByUserId: string;
	revokedAt: Date | string | null;
	revokedByUserId: string | null;
}

interface CommandRow {
	requestHash: string;
	webhookId: string;
}

interface OutboxRow {
	organizationId: string;
	endpointId: string;
	auditEventId: string;
	envelopeId: string;
	eventType: string;
	payloadJson: string;
	status: string;
	attempts: number;
	availableAt: Date | string;
	claimToken: string | null;
	lockedAt: Date | string | null;
	endpointUrl: string;
	signingSecret: string;
	sealingKeyId: string | null;
}

interface LogRow {
	id: string;
	eventType: string;
	status: string;
	attempt: number;
	httpStatus: number | null;
	errorCode: string | null;
	occurredAt: Date | string;
}

const ENDPOINT_COLUMNS: string = `id, organization_id AS "organizationId", url, description, status,
	events_json AS "eventsJson", secret_prefix AS "secretPrefix", created_at AS "createdAt",
	created_by_user_id AS "createdByUserId", revoked_at AS "revokedAt",
	revoked_by_user_id AS "revokedByUserId"`;

export class PostgresWebhookStore implements WebhookStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async createEndpoint(
		command: CreateWebhookEndpointCommand
	): Promise<CreateWebhookEndpointResult> {
		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql) => {
				await this.#lockOrganization(sql, command.organizationId);
				const existing: CommandRow | null = await this.#findCommand(
					sql,
					command.organizationId,
					command.actorId,
					command.idempotencyKey
				);
				if (existing !== null) {
					throw new WebhookRollback(await this.#replayOrConflictCreate(sql, command, existing));
				}
				const [{ n }]: { n: string }[] = await sql<{ n: string }[]>`
					SELECT COUNT(*)::text AS n FROM webhook_endpoint
					WHERE organization_id = ${command.organizationId} AND status = 'active'`;
				if (Number(n) >= WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION) {
					throw new WebhookRollback<CreateWebhookEndpointResult>({ outcome: 'limit_exceeded' });
				}
				const insertedEndpoint: { id: string }[] = await sql<{ id: string }[]>`
					INSERT INTO webhook_endpoint (
						id, organization_id, url, description, status, events_json,
						secret_hash, signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
					) VALUES (
						${command.id}, ${command.organizationId}, ${command.url}, ${command.description},
						'active', ${command.eventsJson}, ${command.secretHash}, ${command.signingSecret},
						${command.sealingKeyId}, ${command.secretPrefix}, ${command.createdAt}::timestamptz, ${command.actorId}
					)
					ON CONFLICT DO NOTHING
					RETURNING id`;
				if (insertedEndpoint.length !== 1) {
					throw new WebhookRollback<CreateWebhookEndpointResult>({ outcome: 'conflict' });
				}
				const insertedCommand: { webhookId: string }[] = await sql<{ webhookId: string }[]>`
					INSERT INTO webhook_endpoint_command (
						organization_id, actor_id, idempotency_key, command_type, request_hash,
						webhook_id, occurred_at
					) VALUES (
						${command.organizationId}, ${command.actorId}, ${command.idempotencyKey}, 'create',
						${command.requestFingerprint}, ${command.id}, ${command.createdAt}::timestamptz
					)
					ON CONFLICT DO NOTHING
					RETURNING webhook_id AS "webhookId"`;
				if (insertedCommand.length !== 1) {
					throw new WebhookRollback(await this.#classifyCreateCollision(sql, command));
				}
				const endpoint: WebhookEndpointMetadata | null = await this.#get(
					sql,
					command.organizationId,
					command.id
				);
				if (endpoint === null) {
					throw new WebhookRollback<CreateWebhookEndpointResult>({ outcome: 'conflict' });
				}
				return { outcome: 'created' as const, endpoint };
			});
		} catch (error: unknown) {
			if (error instanceof WebhookRollback) return error.result;
			throw error;
		}
	}

	async listEndpoints(organizationId: string, query: WebhookListQuery): Promise<WebhookListPage> {
		assertListLimit(query.limit);
		const fetchLimit: number = query.limit + 1;
		const rows: EndpointRow[] =
			query.cursor === null
				? await this.#sql<EndpointRow[]>`
					SELECT ${this.#sql.unsafe(ENDPOINT_COLUMNS)} FROM webhook_endpoint
					WHERE organization_id = ${organizationId}
					ORDER BY created_at DESC, id DESC
					LIMIT ${fetchLimit}`
				: await this.#sql<EndpointRow[]>`
					SELECT ${this.#sql.unsafe(ENDPOINT_COLUMNS)} FROM webhook_endpoint
					WHERE organization_id = ${organizationId}
						AND (created_at, id) < (
							SELECT created_at, id FROM webhook_endpoint
							WHERE organization_id = ${organizationId} AND id = ${query.cursor}
							LIMIT 1
						)
					ORDER BY created_at DESC, id DESC
					LIMIT ${fetchLimit}`;
		const hasMore: boolean = rows.length > query.limit;
		const page: EndpointRow[] = hasMore ? rows.slice(0, query.limit) : rows;
		return {
			items: page.map(metadataFromRow),
			nextCursor: hasMore ? page[page.length - 1].id : null
		};
	}

	async getEndpoint(
		organizationId: string,
		webhookId: string
	): Promise<WebhookEndpointMetadata | null> {
		return this.#get(this.#sql, organizationId, webhookId);
	}

	async revokeEndpoint(
		command: RevokeWebhookEndpointCommand
	): Promise<RevokeWebhookEndpointResult> {
		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql) => {
				const existing: CommandRow | null = await this.#findCommand(
					sql,
					command.organizationId,
					command.actorId,
					command.idempotencyKey
				);
				if (existing !== null) {
					throw new WebhookRollback(await this.#replayOrConflictRevoke(sql, command, existing));
				}
				const updated: { id: string }[] = await sql<{ id: string }[]>`
					UPDATE webhook_endpoint
					SET status = 'revoked', revoked_at = ${command.revokedAt}::timestamptz,
						revoked_by_user_id = ${command.actorId}
					WHERE organization_id = ${command.organizationId}
						AND id = ${command.webhookId}
						AND status = 'active'
					RETURNING id`;
				if (updated.length !== 1) {
					const raced: CommandRow | null = await this.#findCommand(
						sql,
						command.organizationId,
						command.actorId,
						command.idempotencyKey
					);
					if (raced !== null) {
						throw new WebhookRollback(await this.#replayOrConflictRevoke(sql, command, raced));
					}
					const current: WebhookEndpointMetadata | null = await this.#get(
						sql,
						command.organizationId,
						command.webhookId
					);
					if (current === null) {
						throw new WebhookRollback<RevokeWebhookEndpointResult>({ outcome: 'not_found' });
					}
					throw new WebhookRollback<RevokeWebhookEndpointResult>({
						outcome: 'revoked',
						endpoint: current
					});
				}
				const insertedCommand: { webhookId: string }[] = await sql<{ webhookId: string }[]>`
					INSERT INTO webhook_endpoint_command (
						organization_id, actor_id, idempotency_key, command_type, request_hash,
						webhook_id, occurred_at
					) VALUES (
						${command.organizationId}, ${command.actorId}, ${command.idempotencyKey}, 'revoke',
						${command.requestFingerprint}, ${command.webhookId}, ${command.revokedAt}::timestamptz
					)
					ON CONFLICT DO NOTHING
					RETURNING webhook_id AS "webhookId"`;
				if (insertedCommand.length !== 1) {
					throw new WebhookRollback(await this.#classifyRevokeCollision(sql, command));
				}
				const endpoint: WebhookEndpointMetadata | null = await this.#get(
					sql,
					command.organizationId,
					command.webhookId
				);
				if (endpoint === null) {
					throw new WebhookRollback<RevokeWebhookEndpointResult>({ outcome: 'not_found' });
				}
				return { outcome: 'revoked' as const, endpoint };
			});
		} catch (error: unknown) {
			if (error instanceof WebhookRollback) return error.result;
			throw error;
		}
	}

	async claimPendingDeliveries(
		command: ClaimWebhookDeliveriesCommand
	): Promise<readonly WebhookOutboxRow[]> {
		const rows: OutboxRow[] = await this.#sql<OutboxRow[]>`
			WITH candidates AS (
				SELECT organization_id, endpoint_id, audit_event_id
				FROM webhook_outbox
				WHERE (
					(status IN ('pending', 'failed')
						AND retryable
						AND available_at <= ${command.claimedAt}::timestamptz)
					OR (status = 'processing' AND locked_at < ${command.staleBefore}::timestamptz)
				)
				AND attempts < ${WEBHOOK_MAX_ATTEMPTS}
				ORDER BY available_at ASC, endpoint_id ASC, audit_event_id ASC
				FOR UPDATE SKIP LOCKED
				LIMIT ${command.limit}
			)
			UPDATE webhook_outbox AS outbox
			SET status = 'processing',
				claim_token = ${command.claimToken},
				locked_at = ${command.claimedAt}::timestamptz,
				attempts = outbox.attempts + 1,
				updated_at = ${command.claimedAt}::timestamptz
			FROM candidates, webhook_endpoint endpoint
			WHERE outbox.organization_id = candidates.organization_id
				AND outbox.endpoint_id = candidates.endpoint_id
				AND outbox.audit_event_id = candidates.audit_event_id
				AND endpoint.organization_id = outbox.organization_id
				AND endpoint.id = outbox.endpoint_id
				AND endpoint.status = 'active'
			RETURNING
				outbox.organization_id AS "organizationId",
				outbox.endpoint_id AS "endpointId",
				outbox.audit_event_id AS "auditEventId",
				outbox.envelope_id AS "envelopeId",
				outbox.event_type AS "eventType",
				outbox.payload_json AS "payloadJson",
				outbox.status,
				outbox.attempts,
				outbox.available_at AS "availableAt",
				outbox.claim_token AS "claimToken",
				outbox.locked_at AS "lockedAt",
				endpoint.url AS "endpointUrl",
				endpoint.signing_secret AS "signingSecret",
				endpoint.sealing_key_id AS "sealingKeyId"`;
		return rows.map(outboxFromRow);
	}

	async readClaimedDelivery(
		organizationId: string,
		endpointId: string,
		auditEventId: string,
		claimToken: string
	): Promise<WebhookOutboxRow | null> {
		const rows: OutboxRow[] = await this.#sql<OutboxRow[]>`
			SELECT
				outbox.organization_id AS "organizationId",
				outbox.endpoint_id AS "endpointId",
				outbox.audit_event_id AS "auditEventId",
				outbox.envelope_id AS "envelopeId",
				outbox.event_type AS "eventType",
				outbox.payload_json AS "payloadJson",
				outbox.status,
				outbox.attempts,
				outbox.available_at AS "availableAt",
				outbox.claim_token AS "claimToken",
				outbox.locked_at AS "lockedAt",
				endpoint.url AS "endpointUrl",
				endpoint.signing_secret AS "signingSecret",
				endpoint.sealing_key_id AS "sealingKeyId"
			FROM webhook_outbox outbox
			INNER JOIN webhook_endpoint endpoint
				ON endpoint.organization_id = outbox.organization_id
				AND endpoint.id = outbox.endpoint_id
			WHERE outbox.organization_id = ${organizationId}
				AND outbox.endpoint_id = ${endpointId}
				AND outbox.audit_event_id = ${auditEventId}
				AND outbox.claim_token = ${claimToken}
				AND outbox.status = 'processing'`;
		return rows[0] === undefined ? null : outboxFromRow(rows[0]);
	}

	async completeDelivery(
		command: CompleteWebhookDeliveryCommand
	): Promise<{ outcome: 'completed' | 'stale' }> {
		const logId: string = newUuidV7();
		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql) => {
				const updated: { eventType: string; attempts: number }[] = await sql<
					{ eventType: string; attempts: number }[]
				>`
					UPDATE webhook_outbox
					SET status = 'delivered', claim_token = NULL, locked_at = NULL,
						updated_at = ${command.deliveredAt}::timestamptz
					WHERE organization_id = ${command.organizationId}
						AND endpoint_id = ${command.endpointId}
						AND audit_event_id = ${command.auditEventId}
						AND status = 'processing'
						AND claim_token = ${command.claimToken}
					RETURNING event_type AS "eventType", attempts`;
				if (updated.length !== 1) {
					throw new WebhookRollback<{ outcome: 'completed' | 'stale' }>({ outcome: 'stale' });
				}
				await sql`
					INSERT INTO webhook_delivery_log (
						id, organization_id, endpoint_id, audit_event_id, event_type, status,
						attempt, http_status, error_code, occurred_at
					) VALUES (
						${logId}, ${command.organizationId}, ${command.endpointId}, ${command.auditEventId},
						${updated[0].eventType}, 'delivered', ${updated[0].attempts}, ${command.httpStatus},
						NULL, ${command.deliveredAt}::timestamptz
					)`;
				return { outcome: 'completed' as const };
			});
		} catch (error: unknown) {
			if (error instanceof WebhookRollback) return error.result;
			throw error;
		}
	}

	async failDelivery(
		command: FailWebhookDeliveryCommand
	): Promise<{ outcome: 'failed' | 'stale' }> {
		const logId: string = newUuidV7();
		const logStatus: string = command.retryable ? 'retrying' : 'failed';
		try {
			return await this.#sql.begin(async (sql: postgres.TransactionSql) => {
				const updated: { eventType: string; attempts: number }[] = await sql<
					{ eventType: string; attempts: number }[]
				>`
					UPDATE webhook_outbox
					SET status = 'failed', claim_token = NULL, locked_at = NULL,
						available_at = ${command.nextAvailableAt}::timestamptz,
						last_error = ${command.errorCode},
						updated_at = ${command.failedAt}::timestamptz,
						retryable = ${command.retryable}
					WHERE organization_id = ${command.organizationId}
						AND endpoint_id = ${command.endpointId}
						AND audit_event_id = ${command.auditEventId}
						AND status = 'processing'
						AND claim_token = ${command.claimToken}
					RETURNING event_type AS "eventType", attempts`;
				if (updated.length !== 1) {
					throw new WebhookRollback<{ outcome: 'failed' | 'stale' }>({ outcome: 'stale' });
				}
				await sql`
					INSERT INTO webhook_delivery_log (
						id, organization_id, endpoint_id, audit_event_id, event_type, status,
						attempt, http_status, error_code, occurred_at
					) VALUES (
						${logId}, ${command.organizationId}, ${command.endpointId}, ${command.auditEventId},
						${updated[0].eventType}, ${logStatus}, ${updated[0].attempts}, ${command.httpStatus},
						${command.errorCode}, ${command.failedAt}::timestamptz
					)`;
				return { outcome: 'failed' as const };
			});
		} catch (error: unknown) {
			if (error instanceof WebhookRollback) return error.result;
			throw error;
		}
	}

	async listStaleSigningSecrets(
		activeSealingKeyId: string,
		limit: number
	): Promise<readonly WebhookSigningSecretRow[]> {
		const rows: WebhookSigningSecretRow[] = await this.#sql<WebhookSigningSecretRow[]>`
			SELECT organization_id AS "organizationId", id AS "endpointId",
				signing_secret AS "signingSecret", sealing_key_id AS "sealingKeyId"
			FROM webhook_endpoint
			WHERE sealing_key_id IS NULL OR sealing_key_id <> ${activeSealingKeyId}
			ORDER BY created_at ASC, id ASC
			LIMIT ${limit}`;
		return rows;
	}

	async resealSigningSecret(
		command: ResealWebhookSigningSecretCommand
	): Promise<{ outcome: 'resealed' | 'stale' }> {
		const rows: { endpointId: string }[] =
			command.previousSealingKeyId === null
				? await this.#sql<{ endpointId: string }[]>`
					UPDATE webhook_endpoint
					SET signing_secret = ${command.signingSecret}, sealing_key_id = ${command.sealingKeyId}
					WHERE organization_id = ${command.organizationId}
						AND id = ${command.endpointId}
						AND sealing_key_id IS NULL
					RETURNING id AS "endpointId"`
				: await this.#sql<{ endpointId: string }[]>`
					UPDATE webhook_endpoint
					SET signing_secret = ${command.signingSecret}, sealing_key_id = ${command.sealingKeyId}
					WHERE organization_id = ${command.organizationId}
						AND id = ${command.endpointId}
						AND sealing_key_id = ${command.previousSealingKeyId}
					RETURNING id AS "endpointId"`;
		return rows.length === 1 ? { outcome: 'resealed' } : { outcome: 'stale' };
	}

	async listDeliveryLogs(
		organizationId: string,
		webhookId: string,
		query: WebhookListQuery
	): Promise<WebhookDeliveryLogPage> {
		assertListLimit(query.limit);
		const fetchLimit: number = query.limit + 1;
		const rows: LogRow[] =
			query.cursor === null
				? await this.#sql<LogRow[]>`
					SELECT id, event_type AS "eventType", status, attempt,
						http_status AS "httpStatus", error_code AS "errorCode",
						occurred_at AS "occurredAt"
					FROM webhook_delivery_log
					WHERE organization_id = ${organizationId} AND endpoint_id = ${webhookId}
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${fetchLimit}`
				: await this.#sql<LogRow[]>`
					SELECT id, event_type AS "eventType", status, attempt,
						http_status AS "httpStatus", error_code AS "errorCode",
						occurred_at AS "occurredAt"
					FROM webhook_delivery_log
					WHERE organization_id = ${organizationId} AND endpoint_id = ${webhookId}
						AND (occurred_at, id) < (
							SELECT occurred_at, id FROM webhook_delivery_log
							WHERE organization_id = ${organizationId} AND id = ${query.cursor}
							LIMIT 1
						)
					ORDER BY occurred_at DESC, id DESC
					LIMIT ${fetchLimit}`;
		const hasMore: boolean = rows.length > query.limit;
		const page: LogRow[] = hasMore ? rows.slice(0, query.limit) : rows;
		return {
			items: page.map((row: LogRow) => ({
				id: row.id,
				eventType: row.eventType,
				status: row.status as 'delivered' | 'failed' | 'retrying',
				attempt: row.attempt,
				httpStatus: row.httpStatus,
				errorCode: row.errorCode,
				occurredAt: isoTimestamp(row.occurredAt) ?? ''
			})),
			nextCursor: hasMore ? page[page.length - 1].id : null
		};
	}

	async #get(
		sql: Sql,
		organizationId: string,
		webhookId: string
	): Promise<WebhookEndpointMetadata | null> {
		const rows: EndpointRow[] = await sql<EndpointRow[]>`
			SELECT ${sql.unsafe(ENDPOINT_COLUMNS)} FROM webhook_endpoint
			WHERE organization_id = ${organizationId} AND id = ${webhookId}`;
		return rows[0] === undefined ? null : metadataFromRow(rows[0]);
	}

	async #lockOrganization(sql: Sql, organizationId: string): Promise<void> {
		await sql`
			SELECT id FROM organization WHERE id = ${organizationId} FOR NO KEY UPDATE`;
	}

	async #findCommand(
		sql: Sql,
		organizationId: string,
		actorId: string,
		idempotencyKey: string
	): Promise<CommandRow | null> {
		const existing: CommandRow[] = await sql<CommandRow[]>`
			SELECT request_hash AS "requestHash", webhook_id AS "webhookId"
			FROM webhook_endpoint_command
			WHERE organization_id = ${organizationId}
				AND actor_id = ${actorId}
				AND idempotency_key = ${idempotencyKey}
			FOR UPDATE`;
		return existing[0] ?? null;
	}

	async #classifyCreateCollision(
		sql: Sql,
		command: CreateWebhookEndpointCommand
	): Promise<CreateWebhookEndpointResult> {
		const existing: CommandRow | null = await this.#findCommand(
			sql,
			command.organizationId,
			command.actorId,
			command.idempotencyKey
		);
		if (existing === null) return { outcome: 'conflict' };
		return this.#replayOrConflictCreate(sql, command, existing);
	}

	async #classifyRevokeCollision(
		sql: Sql,
		command: RevokeWebhookEndpointCommand
	): Promise<RevokeWebhookEndpointResult> {
		const existing: CommandRow | null = await this.#findCommand(
			sql,
			command.organizationId,
			command.actorId,
			command.idempotencyKey
		);
		if (existing === null) return { outcome: 'conflict' };
		return this.#replayOrConflictRevoke(sql, command, existing);
	}

	async #replayOrConflictCreate(
		sql: Sql,
		command: CreateWebhookEndpointCommand,
		row: CommandRow
	): Promise<CreateWebhookEndpointResult> {
		if (row.requestHash !== command.requestFingerprint) return { outcome: 'conflict' };
		const endpoint: WebhookEndpointMetadata | null = await this.#get(
			sql,
			command.organizationId,
			row.webhookId
		);
		return endpoint === null ? { outcome: 'conflict' } : { outcome: 'replayed', endpoint };
	}

	async #replayOrConflictRevoke(
		sql: Sql,
		command: RevokeWebhookEndpointCommand,
		row: CommandRow
	): Promise<RevokeWebhookEndpointResult> {
		if (row.requestHash !== command.requestFingerprint) return { outcome: 'conflict' };
		const endpoint: WebhookEndpointMetadata | null = await this.#get(
			sql,
			command.organizationId,
			row.webhookId
		);
		return endpoint === null ? { outcome: 'not_found' } : { outcome: 'replayed', endpoint };
	}
}

function assertListLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WEBHOOK_LIST_LIMIT) {
		throw new RangeError(`Webhook list limit must be between 1 and ${MAX_WEBHOOK_LIST_LIMIT}`);
	}
}

function metadataFromRow(row: EndpointRow): WebhookEndpointMetadata {
	const events: unknown = JSON.parse(row.eventsJson);
	if (
		!Array.isArray(events) ||
		events.some((value: unknown): boolean => typeof value !== 'string')
	) {
		throw new Error('Stored webhook events are not a string array');
	}
	if (row.status !== 'active' && row.status !== 'revoked') {
		throw new Error('Stored webhook status is not canonical');
	}
	const createdAt: string | null = isoTimestamp(row.createdAt);
	if (createdAt === null) throw new Error('Stored webhook createdAt is not canonical');
	return {
		id: row.id,
		organizationId: row.organizationId,
		url: row.url,
		description: row.description,
		status: row.status as WebhookStatus,
		events: events as readonly string[],
		secretPrefix: row.secretPrefix,
		createdAt,
		createdByUserId: row.createdByUserId,
		revokedAt: isoTimestamp(row.revokedAt),
		revokedByUserId: row.revokedByUserId
	};
}

function outboxFromRow(row: OutboxRow): WebhookOutboxRow {
	if (row.claimToken === null) throw new Error('Claimed webhook row is missing a claim token');
	return {
		organizationId: row.organizationId,
		endpointId: row.endpointId,
		auditEventId: row.auditEventId,
		envelopeId: row.envelopeId,
		eventType: row.eventType,
		payloadJson: row.payloadJson,
		endpointUrl: row.endpointUrl,
		signingSecret: row.signingSecret,
		sealingKeyId: row.sealingKeyId,
		claimToken: row.claimToken,
		status: 'processing',
		attempts: row.attempts,
		availableAt: isoTimestamp(row.availableAt) ?? '',
		lockedAt: isoTimestamp(row.lockedAt) ?? ''
	};
}

function isoTimestamp(value: Date | string | null): string | null {
	if (value === null) return null;
	const milliseconds: number = value instanceof Date ? value.valueOf() : Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
