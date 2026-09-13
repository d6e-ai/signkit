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
	type WebhookDeliveryLogPage,
	type WebhookEndpointMetadata,
	type WebhookListPage,
	type WebhookListQuery,
	type WebhookOutboxRow,
	type WebhookStatus,
	type WebhookStore
} from '$lib/ports/webhook-store';

const ENDPOINT_COLUMNS: string = `id, organization_id, url, description, status, events_json,
	secret_prefix, created_at, created_by_user_id, revoked_at, revoked_by_user_id`;

interface EndpointRow {
	id: string;
	organization_id: string;
	url: string;
	description: string | null;
	status: string;
	events_json: string;
	secret_prefix: string;
	created_at: string;
	created_by_user_id: string;
	revoked_at: string | null;
	revoked_by_user_id: string | null;
}

interface CommandRow {
	request_hash: string;
	webhook_id: string;
}

interface OutboxRow {
	organization_id: string;
	endpoint_id: string;
	audit_event_id: string;
	envelope_id: string;
	event_type: string;
	payload_json: string;
	status: string;
	attempts: number;
	available_at: string;
	claim_token: string | null;
	locked_at: string | null;
	endpoint_url: string;
	signing_secret: string;
}

interface LogRow {
	id: string;
	event_type: string;
	status: string;
	attempt: number;
	http_status: number | null;
	error_code: string | null;
	occurred_at: string;
}

export class D1WebhookStore implements WebhookStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async createEndpoint(
		command: CreateWebhookEndpointCommand
	): Promise<CreateWebhookEndpointResult> {
		const existing: D1Result<CommandRow> = await this.#database
			.prepare(
				`SELECT request_hash, webhook_id FROM webhook_endpoint_command
				 WHERE organization_id = ? AND actor_id = ? AND idempotency_key = ?`
			)
			.bind(command.organizationId, command.actorId, command.idempotencyKey)
			.all();
		if (existing.results.length === 1) {
			return this.#replayOrConflict(command, existing.results[0]);
		}

		const count: D1Result<{ n: number }> = await this.#database
			.prepare(
				`SELECT COUNT(*) AS n FROM webhook_endpoint
				 WHERE organization_id = ? AND status = 'active'`
			)
			.bind(command.organizationId)
			.all();
		if ((count.results[0]?.n ?? 0) >= WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION) {
			return { outcome: 'limit_exceeded' };
		}

		try {
			const results: D1Result[] = await this.#database.batch([
				this.#database
					.prepare(
						`INSERT INTO webhook_endpoint (
							id, organization_id, url, description, status, events_json,
							secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id
						) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						command.id,
						command.organizationId,
						command.url,
						command.description,
						command.eventsJson,
						command.secretHash,
						command.signingSecret,
						command.secretPrefix,
						command.createdAt,
						command.actorId
					),
				this.#database
					.prepare(
						`INSERT INTO webhook_endpoint_command (
							organization_id, actor_id, idempotency_key, command_type, request_hash,
							webhook_id, occurred_at
						) VALUES (?, ?, ?, 'create', ?, ?, ?)`
					)
					.bind(
						command.organizationId,
						command.actorId,
						command.idempotencyKey,
						command.requestFingerprint,
						command.id,
						command.createdAt
					)
			]);
			if (!results.every((result: D1Result): boolean => (result.meta.changes ?? 0) === 1)) {
				return { outcome: 'conflict' };
			}
		} catch {
			const again: D1Result<CommandRow> = await this.#database
				.prepare(
					`SELECT request_hash, webhook_id FROM webhook_endpoint_command
					 WHERE organization_id = ? AND actor_id = ? AND idempotency_key = ?`
				)
				.bind(command.organizationId, command.actorId, command.idempotencyKey)
				.all();
			if (again.results.length === 1) return this.#replayOrConflict(command, again.results[0]);
			throw new Error('Webhook endpoint create failed');
		}
		const endpoint: WebhookEndpointMetadata | null = await this.getEndpoint(
			command.organizationId,
			command.id
		);
		return endpoint === null ? { outcome: 'conflict' } : { outcome: 'created', endpoint };
	}

	async listEndpoints(organizationId: string, query: WebhookListQuery): Promise<WebhookListPage> {
		assertListLimit(query.limit);
		const fetchLimit: number = query.limit + 1;
		const result: D1Result<EndpointRow> =
			query.cursor === null
				? await this.#database
						.prepare(
							`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoint
							 WHERE organization_id = ?
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, fetchLimit)
						.all()
				: await this.#database
						.prepare(
							`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoint
							 WHERE organization_id = ?
							   AND (created_at, id) < (
									SELECT created_at, id FROM webhook_endpoint
									WHERE organization_id = ? AND id = ? LIMIT 1
							   )
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, organizationId, query.cursor, fetchLimit)
						.all();
		const rows: EndpointRow[] = result.results;
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
		const result: D1Result<EndpointRow> = await this.#database
			.prepare(
				`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoint
				 WHERE organization_id = ? AND id = ?`
			)
			.bind(organizationId, webhookId)
			.all();
		const row: EndpointRow | undefined = result.results[0];
		return row === undefined ? null : metadataFromRow(row);
	}

	async revokeEndpoint(
		command: RevokeWebhookEndpointCommand
	): Promise<RevokeWebhookEndpointResult> {
		const existing: D1Result<CommandRow> = await this.#database
			.prepare(
				`SELECT request_hash, webhook_id FROM webhook_endpoint_command
				 WHERE organization_id = ? AND actor_id = ? AND idempotency_key = ?`
			)
			.bind(command.organizationId, command.actorId, command.idempotencyKey)
			.all();
		if (existing.results.length === 1) {
			if (existing.results[0].request_hash !== command.requestFingerprint) {
				return { outcome: 'conflict' };
			}
			const endpoint: WebhookEndpointMetadata | null = await this.getEndpoint(
				command.organizationId,
				existing.results[0].webhook_id
			);
			return endpoint === null ? { outcome: 'not_found' } : { outcome: 'replayed', endpoint };
		}

		try {
			const results: D1Result[] = await this.#database.batch([
				this.#database
					.prepare(
						`UPDATE webhook_endpoint
						 SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?
						 WHERE organization_id = ? AND id = ? AND status = 'active'`
					)
					.bind(command.revokedAt, command.actorId, command.organizationId, command.webhookId),
				this.#database
					.prepare(
						`INSERT INTO webhook_endpoint_command (
							organization_id, actor_id, idempotency_key, command_type, request_hash,
							webhook_id, occurred_at
						) VALUES (?, ?, ?, 'revoke', ?, ?, ?)`
					)
					.bind(
						command.organizationId,
						command.actorId,
						command.idempotencyKey,
						command.requestFingerprint,
						command.webhookId,
						command.revokedAt
					)
			]);
			if ((results[0]?.meta.changes ?? 0) !== 1) {
				const current: WebhookEndpointMetadata | null = await this.getEndpoint(
					command.organizationId,
					command.webhookId
				);
				return current === null
					? { outcome: 'not_found' }
					: { outcome: 'revoked', endpoint: current };
			}
		} catch {
			return { outcome: 'conflict' };
		}
		const endpoint: WebhookEndpointMetadata | null = await this.getEndpoint(
			command.organizationId,
			command.webhookId
		);
		return endpoint === null ? { outcome: 'not_found' } : { outcome: 'revoked', endpoint };
	}

	async claimPendingDeliveries(
		command: ClaimWebhookDeliveriesCommand
	): Promise<readonly WebhookOutboxRow[]> {
		await this.#database
			.prepare(
				`UPDATE webhook_outbox
				 SET status = 'processing', claim_token = ?, locked_at = ?,
					attempts = attempts + 1, updated_at = ?
				 WHERE rowid IN (
					SELECT webhook_outbox.rowid
					FROM webhook_outbox
					INNER JOIN webhook_endpoint
						ON webhook_endpoint.organization_id = webhook_outbox.organization_id
						AND webhook_endpoint.id = webhook_outbox.endpoint_id
						AND webhook_endpoint.status = 'active'
					WHERE (
						(webhook_outbox.status IN ('pending', 'failed')
							AND webhook_outbox.available_at <= ?
							AND webhook_outbox.attempts < ?)
						OR (webhook_outbox.status = 'processing' AND webhook_outbox.locked_at < ?)
					)
					ORDER BY webhook_outbox.available_at ASC, webhook_outbox.endpoint_id ASC,
						webhook_outbox.audit_event_id ASC
					LIMIT ?
				 )`
			)
			.bind(
				command.claimToken,
				command.claimedAt,
				command.claimedAt,
				command.claimedAt,
				WEBHOOK_MAX_ATTEMPTS,
				command.staleBefore,
				command.limit
			)
			.run();
		const claimed: D1Result<OutboxRow> = await this.#database
			.prepare(
				`SELECT
					webhook_outbox.organization_id, webhook_outbox.endpoint_id, webhook_outbox.audit_event_id,
					webhook_outbox.envelope_id, webhook_outbox.event_type, webhook_outbox.payload_json,
					webhook_outbox.status, webhook_outbox.attempts, webhook_outbox.available_at,
					webhook_outbox.claim_token, webhook_outbox.locked_at,
					webhook_endpoint.url AS endpoint_url, webhook_endpoint.signing_secret
				 FROM webhook_outbox
				 INNER JOIN webhook_endpoint
					ON webhook_endpoint.organization_id = webhook_outbox.organization_id
					AND webhook_endpoint.id = webhook_outbox.endpoint_id
				 WHERE webhook_outbox.claim_token = ? AND webhook_outbox.status = 'processing'`
			)
			.bind(command.claimToken)
			.all();
		return claimed.results.map(outboxFromRow);
	}

	async readClaimedDelivery(
		organizationId: string,
		endpointId: string,
		auditEventId: string,
		claimToken: string
	): Promise<WebhookOutboxRow | null> {
		const result: D1Result<OutboxRow> = await this.#database
			.prepare(
				`SELECT
					webhook_outbox.organization_id, webhook_outbox.endpoint_id, webhook_outbox.audit_event_id,
					webhook_outbox.envelope_id, webhook_outbox.event_type, webhook_outbox.payload_json,
					webhook_outbox.status, webhook_outbox.attempts, webhook_outbox.available_at,
					webhook_outbox.claim_token, webhook_outbox.locked_at,
					webhook_endpoint.url AS endpoint_url, webhook_endpoint.signing_secret
				 FROM webhook_outbox
				 INNER JOIN webhook_endpoint
					ON webhook_endpoint.organization_id = webhook_outbox.organization_id
					AND webhook_endpoint.id = webhook_outbox.endpoint_id
				 WHERE webhook_outbox.organization_id = ?
					AND webhook_outbox.endpoint_id = ?
					AND webhook_outbox.audit_event_id = ?
					AND webhook_outbox.claim_token = ?
					AND webhook_outbox.status = 'processing'`
			)
			.bind(organizationId, endpointId, auditEventId, claimToken)
			.all();
		const row: OutboxRow | undefined = result.results[0];
		return row === undefined ? null : outboxFromRow(row);
	}

	async completeDelivery(
		command: CompleteWebhookDeliveryCommand
	): Promise<{ outcome: 'completed' | 'stale' }> {
		const logId: string = newUuidV7();
		const results: D1Result[] = await this.#database.batch([
			this.#database
				.prepare(
					`UPDATE webhook_outbox
					 SET status = 'delivered', claim_token = NULL, locked_at = NULL, updated_at = ?
					 WHERE organization_id = ? AND endpoint_id = ? AND audit_event_id = ?
						AND status = 'processing' AND claim_token = ?`
				)
				.bind(
					command.deliveredAt,
					command.organizationId,
					command.endpointId,
					command.auditEventId,
					command.claimToken
				),
			this.#database
				.prepare(
					`INSERT INTO webhook_delivery_log (
						id, organization_id, endpoint_id, audit_event_id, event_type, status,
						attempt, http_status, error_code, occurred_at
					)
					SELECT ?, organization_id, endpoint_id, audit_event_id, event_type, 'delivered',
						attempts, ?, NULL, ?
					FROM webhook_outbox
					WHERE organization_id = ? AND endpoint_id = ? AND audit_event_id = ?
						AND status = 'delivered'`
				)
				.bind(
					logId,
					command.httpStatus,
					command.deliveredAt,
					command.organizationId,
					command.endpointId,
					command.auditEventId
				)
		]);
		return (results[0]?.meta.changes ?? 0) === 1 ? { outcome: 'completed' } : { outcome: 'stale' };
	}

	async failDelivery(
		command: FailWebhookDeliveryCommand
	): Promise<{ outcome: 'failed' | 'stale' }> {
		const logId: string = newUuidV7();
		const logStatus: string = command.retryable ? 'retrying' : 'failed';
		const results: D1Result[] = await this.#database.batch([
			this.#database
				.prepare(
					`UPDATE webhook_outbox
					 SET status = 'failed', claim_token = NULL, locked_at = NULL,
						available_at = ?, last_error = ?, updated_at = ?
					 WHERE organization_id = ? AND endpoint_id = ? AND audit_event_id = ?
						AND status = 'processing' AND claim_token = ?`
				)
				.bind(
					command.nextAvailableAt,
					command.errorCode,
					command.failedAt,
					command.organizationId,
					command.endpointId,
					command.auditEventId,
					command.claimToken
				),
			this.#database
				.prepare(
					`INSERT INTO webhook_delivery_log (
						id, organization_id, endpoint_id, audit_event_id, event_type, status,
						attempt, http_status, error_code, occurred_at
					)
					SELECT ?, organization_id, endpoint_id, audit_event_id, event_type, ?,
						attempts, ?, ?, ?
					FROM webhook_outbox
					WHERE organization_id = ? AND endpoint_id = ? AND audit_event_id = ?`
				)
				.bind(
					logId,
					logStatus,
					command.httpStatus,
					command.errorCode,
					command.failedAt,
					command.organizationId,
					command.endpointId,
					command.auditEventId
				)
		]);
		return (results[0]?.meta.changes ?? 0) === 1 ? { outcome: 'failed' } : { outcome: 'stale' };
	}

	async listDeliveryLogs(
		organizationId: string,
		webhookId: string,
		query: WebhookListQuery
	): Promise<WebhookDeliveryLogPage> {
		assertListLimit(query.limit);
		const fetchLimit: number = query.limit + 1;
		const result: D1Result<LogRow> =
			query.cursor === null
				? await this.#database
						.prepare(
							`SELECT id, event_type, status, attempt, http_status, error_code, occurred_at
							 FROM webhook_delivery_log
							 WHERE organization_id = ? AND endpoint_id = ?
							 ORDER BY occurred_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, webhookId, fetchLimit)
						.all()
				: await this.#database
						.prepare(
							`SELECT id, event_type, status, attempt, http_status, error_code, occurred_at
							 FROM webhook_delivery_log
							 WHERE organization_id = ? AND endpoint_id = ?
							   AND (occurred_at, id) < (
									SELECT occurred_at, id FROM webhook_delivery_log
									WHERE organization_id = ? AND id = ? LIMIT 1
							   )
							 ORDER BY occurred_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, webhookId, organizationId, query.cursor, fetchLimit)
						.all();
		const rows: LogRow[] = result.results;
		const hasMore: boolean = rows.length > query.limit;
		const page: LogRow[] = hasMore ? rows.slice(0, query.limit) : rows;
		return {
			items: page.map((row: LogRow) => ({
				id: row.id,
				eventType: row.event_type,
				status: row.status as 'delivered' | 'failed' | 'retrying',
				attempt: row.attempt,
				httpStatus: row.http_status,
				errorCode: row.error_code,
				occurredAt: row.occurred_at
			})),
			nextCursor: hasMore ? page[page.length - 1].id : null
		};
	}

	async #replayOrConflict(
		command: CreateWebhookEndpointCommand,
		row: CommandRow
	): Promise<CreateWebhookEndpointResult> {
		if (row.request_hash !== command.requestFingerprint) return { outcome: 'conflict' };
		const endpoint: WebhookEndpointMetadata | null = await this.getEndpoint(
			command.organizationId,
			row.webhook_id
		);
		return endpoint === null ? { outcome: 'conflict' } : { outcome: 'replayed', endpoint };
	}
}

function assertListLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WEBHOOK_LIST_LIMIT) {
		throw new RangeError(`Webhook list limit must be between 1 and ${MAX_WEBHOOK_LIST_LIMIT}`);
	}
}

function metadataFromRow(row: EndpointRow): WebhookEndpointMetadata {
	const events: unknown = JSON.parse(row.events_json);
	if (
		!Array.isArray(events) ||
		events.some((value: unknown): boolean => typeof value !== 'string')
	) {
		throw new Error('Stored webhook events are not a string array');
	}
	if (row.status !== 'active' && row.status !== 'revoked') {
		throw new Error('Stored webhook status is not canonical');
	}
	return {
		id: row.id,
		organizationId: row.organization_id,
		url: row.url,
		description: row.description,
		status: row.status as WebhookStatus,
		events: events as readonly string[],
		secretPrefix: row.secret_prefix,
		createdAt: row.created_at,
		createdByUserId: row.created_by_user_id,
		revokedAt: row.revoked_at,
		revokedByUserId: row.revoked_by_user_id
	};
}

function outboxFromRow(row: OutboxRow): WebhookOutboxRow {
	if (row.claim_token === null) throw new Error('Claimed webhook row is missing a claim token');
	return {
		organizationId: row.organization_id,
		endpointId: row.endpoint_id,
		auditEventId: row.audit_event_id,
		envelopeId: row.envelope_id,
		eventType: row.event_type,
		payloadJson: row.payload_json,
		endpointUrl: row.endpoint_url,
		signingSecret: row.signing_secret,
		claimToken: row.claim_token,
		status: 'processing',
		attempts: row.attempts,
		availableAt: row.available_at,
		lockedAt: row.locked_at ?? row.available_at
	};
}
