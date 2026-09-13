import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import {
	DEFAULT_WEBHOOK_LIST_LIMIT,
	MAX_WEBHOOK_LIST_LIMIT,
	boundWebhookClaimLimit,
	type CreateWebhookEndpointResult,
	type WebhookDeliveryLogPage,
	type WebhookEndpointMetadata,
	type WebhookListPage,
	type WebhookOutboxRow,
	type WebhookStore
} from '$lib/ports/webhook-store';
import { newOpaqueToken } from '$lib/security/opaque-token';
import {
	WEBHOOK_CLAIM_LEASE_MS,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_DESCRIPTION_LENGTH,
	WEBHOOK_MAX_URL_LENGTH,
	WEBHOOK_RETRY_BASE_DELAY_MS,
	canonicalizeWebhookEvents,
	issueWebhookSecret,
	signWebhookPayload
} from '$lib/security/webhook';
import {
	WebhookTargetRejectedError,
	assertWebhookHttpsUrl,
	assertWebhookTargetSafe
} from '$lib/security/webhook-url';

const MAX_CREDENTIAL_ATTEMPTS: number = 3;

export class InvalidWebhookRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidWebhookRequestError';
	}
}

export interface WebhookRequestActor {
	id: string;
	organizationId: string;
}

export interface CreateWebhookInput {
	idempotencyKey: string;
	url: string;
	description: string | null;
	events: readonly string[];
}

export type CreateWebhookResult =
	| { outcome: 'created'; endpoint: WebhookEndpointMetadata; secret: string }
	| { outcome: 'replayed'; endpoint: WebhookEndpointMetadata }
	| { outcome: 'conflict' }
	| { outcome: 'limit_exceeded' };

export type RevokeWebhookResult =
	| { outcome: 'revoked' | 'replayed'; endpoint: WebhookEndpointMetadata }
	| { outcome: 'conflict' }
	| { outcome: 'not_found' };

export interface WebhookDeliveryBatchResult {
	claimed: number;
	delivered: number;
	retried: number;
	failed: number;
}

export interface WebhookApplicationPort {
	createEndpoint(
		actor: WebhookRequestActor,
		input: CreateWebhookInput
	): Promise<CreateWebhookResult>;
	listEndpoints(
		actor: WebhookRequestActor,
		query: { cursor: string | null; limit: number }
	): Promise<WebhookListPage>;
	getEndpoint(
		actor: WebhookRequestActor,
		webhookId: string
	): Promise<WebhookEndpointMetadata | null>;
	revokeEndpoint(
		actor: WebhookRequestActor,
		webhookId: string,
		idempotencyKey: string
	): Promise<RevokeWebhookResult>;
	listDeliveryLogs(
		actor: WebhookRequestActor,
		webhookId: string,
		query: { cursor: string | null; limit: number }
	): Promise<WebhookDeliveryLogPage | null>;
	drainPendingDeliveries(limit: number): Promise<WebhookDeliveryBatchResult>;
}

export class WebhookApplication implements WebhookApplicationPort {
	readonly #store: WebhookStore;
	readonly #newId: UuidV7Generator;
	readonly #now: () => Date;
	readonly #dispatch: typeof dispatchWebhook;

	constructor(
		store: WebhookStore,
		options: {
			newId?: UuidV7Generator;
			now?: () => Date;
			dispatch?: typeof dispatchWebhook;
		} = {}
	) {
		this.#store = store;
		this.#newId = options.newId ?? newUuidV7;
		this.#now = options.now ?? ((): Date => new Date());
		this.#dispatch = options.dispatch ?? dispatchWebhook;
	}

	async createEndpoint(
		actor: WebhookRequestActor,
		input: CreateWebhookInput
	): Promise<CreateWebhookResult> {
		const url: URL = assertWebhookHttpsUrl(input.url);
		if (url.href.length > WEBHOOK_MAX_URL_LENGTH) {
			throw new InvalidWebhookRequestError('Webhook URL exceeds the allowed length');
		}
		const description: string | null = normalizeDescription(input.description);
		const events: readonly string[] = canonicalizeWebhookEvents(input.events);
		const eventsJson: string = JSON.stringify(events);
		const requestFingerprint: string = await sha256(
			JSON.stringify({ url: url.href, description, events })
		);
		const createdAt: string = this.#now().toISOString();

		for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
			const issued = await issueWebhookSecret();
			const result: CreateWebhookEndpointResult = await this.#store.createEndpoint({
				id: this.#newId(),
				organizationId: actor.organizationId,
				actorId: actor.id,
				idempotencyKey: input.idempotencyKey,
				requestFingerprint,
				url: url.href,
				description,
				eventsJson,
				secretHash: issued.secretHash,
				signingSecret: issued.secret,
				secretPrefix: issued.secretPrefix,
				createdAt
			});
			if (result.outcome === 'created') {
				return { outcome: 'created', endpoint: result.endpoint, secret: issued.secret };
			}
			if (result.outcome === 'replayed') {
				return { outcome: 'replayed', endpoint: result.endpoint };
			}
			if (result.outcome === 'conflict' || result.outcome === 'limit_exceeded') {
				return { outcome: result.outcome };
			}
		}
		throw new Error('Webhook secret issuance exhausted');
	}

	listEndpoints(
		actor: WebhookRequestActor,
		query: { cursor: string | null; limit: number }
	): Promise<WebhookListPage> {
		return this.#store.listEndpoints(actor.organizationId, {
			cursor: query.cursor,
			limit: boundListLimit(query.limit)
		});
	}

	getEndpoint(
		actor: WebhookRequestActor,
		webhookId: string
	): Promise<WebhookEndpointMetadata | null> {
		return this.#store.getEndpoint(actor.organizationId, webhookId);
	}

	revokeEndpoint(
		actor: WebhookRequestActor,
		webhookId: string,
		idempotencyKey: string
	): Promise<RevokeWebhookResult> {
		return sha256(JSON.stringify({ webhookId })).then(
			(requestFingerprint: string): Promise<RevokeWebhookResult> =>
				this.#store.revokeEndpoint({
					organizationId: actor.organizationId,
					webhookId,
					actorId: actor.id,
					idempotencyKey,
					requestFingerprint,
					revokedAt: this.#now().toISOString()
				})
		);
	}

	async listDeliveryLogs(
		actor: WebhookRequestActor,
		webhookId: string,
		query: { cursor: string | null; limit: number }
	): Promise<WebhookDeliveryLogPage | null> {
		const endpoint: WebhookEndpointMetadata | null = await this.#store.getEndpoint(
			actor.organizationId,
			webhookId
		);
		if (endpoint === null) return null;
		return this.#store.listDeliveryLogs(actor.organizationId, webhookId, {
			cursor: query.cursor,
			limit: boundListLimit(query.limit)
		});
	}

	async drainPendingDeliveries(limit: number): Promise<WebhookDeliveryBatchResult> {
		const claimedAt: Date = this.#now();
		const claimedAtIso: string = claimedAt.toISOString();
		const staleBefore: string = new Date(
			claimedAt.valueOf() - WEBHOOK_CLAIM_LEASE_MS
		).toISOString();
		const rows: readonly WebhookOutboxRow[] = await this.#store.claimPendingDeliveries({
			claimToken: newOpaqueToken(),
			claimedAt: claimedAtIso,
			staleBefore,
			limit: boundWebhookClaimLimit(limit)
		});
		let delivered = 0;
		let retried = 0;
		let failed = 0;
		for (const row of rows) {
			const outcome = await this.#deliverOne(row, claimedAt);
			if (outcome === 'delivered') delivered += 1;
			else if (outcome === 'retried') retried += 1;
			else failed += 1;
		}
		return { claimed: rows.length, delivered, retried, failed };
	}

	async #deliverOne(
		row: WebhookOutboxRow,
		claimedAt: Date
	): Promise<'delivered' | 'retried' | 'failed'> {
		const timestamp: string = String(Math.floor(claimedAt.valueOf() / 1000));
		try {
			if (new TextEncoder().encode(row.payloadJson).byteLength > 32 * 1024) {
				await this.#store.failDelivery({
					organizationId: row.organizationId,
					endpointId: row.endpointId,
					auditEventId: row.auditEventId,
					claimToken: row.claimToken,
					failedAt: claimedAt.toISOString(),
					retryable: false,
					nextAvailableAt: claimedAt.toISOString(),
					errorCode: 'payload_too_large',
					httpStatus: null
				});
				return 'failed';
			}
			const result = await this.#dispatch({
				url: row.endpointUrl,
				secret: row.signingSecret,
				timestamp,
				body: row.payloadJson,
				eventType: row.eventType,
				endpointId: row.endpointId,
				auditEventId: row.auditEventId
			});
			if (result.ok) {
				await this.#store.completeDelivery({
					organizationId: row.organizationId,
					endpointId: row.endpointId,
					auditEventId: row.auditEventId,
					claimToken: row.claimToken,
					deliveredAt: claimedAt.toISOString(),
					httpStatus: result.status
				});
				return 'delivered';
			}
			const retryable: boolean = result.retryable && row.attempts < WEBHOOK_MAX_ATTEMPTS;
			const delayMs: number =
				WEBHOOK_RETRY_BASE_DELAY_MS * Math.min(2 ** Math.max(row.attempts - 1, 0), 32);
			await this.#store.failDelivery({
				organizationId: row.organizationId,
				endpointId: row.endpointId,
				auditEventId: row.auditEventId,
				claimToken: row.claimToken,
				failedAt: claimedAt.toISOString(),
				retryable,
				nextAvailableAt: new Date(claimedAt.valueOf() + delayMs).toISOString(),
				errorCode: result.errorCode,
				httpStatus: result.status
			});
			return retryable ? 'retried' : 'failed';
		} catch (error: unknown) {
			const rejected: boolean = error instanceof WebhookTargetRejectedError;
			await this.#store.failDelivery({
				organizationId: row.organizationId,
				endpointId: row.endpointId,
				auditEventId: row.auditEventId,
				claimToken: row.claimToken,
				failedAt: claimedAt.toISOString(),
				retryable: !rejected && row.attempts < WEBHOOK_MAX_ATTEMPTS,
				nextAvailableAt: new Date(claimedAt.valueOf() + WEBHOOK_RETRY_BASE_DELAY_MS).toISOString(),
				errorCode: rejected ? 'ssrf_rejected' : 'dispatch_failed',
				httpStatus: null
			});
			return rejected || row.attempts >= WEBHOOK_MAX_ATTEMPTS ? 'failed' : 'retried';
		}
	}
}

export interface WebhookDispatchRequest {
	url: string;
	secret: string;
	timestamp: string;
	body: string;
	eventType: string;
	endpointId: string;
	auditEventId: string;
}

export async function dispatchWebhook(
	request: WebhookDispatchRequest
): Promise<
	| { ok: true; status: number }
	| { ok: false; retryable: boolean; status: number | null; errorCode: string }
> {
	await assertWebhookTargetSafe(request.url);
	const signature: string = await signWebhookPayload(
		request.secret,
		request.timestamp,
		request.body
	);
	let response: Response;
	try {
		response = await fetch(request.url, {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/json',
				'signkit-event': request.eventType,
				'signkit-webhook-id': request.endpointId,
				'signkit-delivery-id': request.auditEventId,
				'signkit-webhook-timestamp': request.timestamp,
				'signkit-webhook-signature': signature
			},
			body: request.body,
			signal: AbortSignal.timeout(10_000)
		});
	} catch {
		return { ok: false, retryable: true, status: null, errorCode: 'network_error' };
	}
	if (response.status >= 200 && response.status < 300) {
		return { ok: true, status: response.status };
	}
	const retryable: boolean =
		response.status === 408 || response.status === 429 || response.status >= 500;
	return {
		ok: false,
		retryable,
		status: response.status,
		errorCode: `http_${response.status}`
	};
}

function boundListLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return DEFAULT_WEBHOOK_LIST_LIMIT;
	return Math.min(limit, MAX_WEBHOOK_LIST_LIMIT);
}

function normalizeDescription(value: string | null): string | null {
	if (value === null) return null;
	const trimmed: string = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > WEBHOOK_MAX_DESCRIPTION_LENGTH) {
		throw new InvalidWebhookRequestError('Webhook description exceeds the allowed length');
	}
	return trimmed;
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
