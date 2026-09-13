import { WEBHOOK_AUDIT_EVENT_TYPES } from '$lib/domain/audit';
import { MAX_WEBHOOK_CLAIM_BATCH } from '$lib/security/webhook';

export const DEFAULT_WEBHOOK_LIST_LIMIT: number = 50;
export const MAX_WEBHOOK_LIST_LIMIT: number = 100;

export const WEBHOOK_STATUSES = ['active', 'revoked'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export interface WebhookEndpointMetadata {
	id: string;
	organizationId: string;
	url: string;
	description: string | null;
	status: WebhookStatus;
	events: readonly string[];
	secretPrefix: string;
	createdAt: string;
	createdByUserId: string;
	revokedAt: string | null;
	revokedByUserId: string | null;
}

export interface CreateWebhookEndpointCommand {
	id: string;
	organizationId: string;
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	url: string;
	description: string | null;
	eventsJson: string;
	secretHash: string;
	signingSecret: string;
	sealingKeyId: string;
	secretPrefix: string;
	createdAt: string;
}

export type CreateWebhookEndpointResult =
	| { outcome: 'created'; endpoint: WebhookEndpointMetadata }
	| { outcome: 'replayed'; endpoint: WebhookEndpointMetadata }
	| { outcome: 'conflict' }
	| { outcome: 'limit_exceeded' };

export interface RevokeWebhookEndpointCommand {
	organizationId: string;
	webhookId: string;
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	revokedAt: string;
}

export type RevokeWebhookEndpointResult =
	| { outcome: 'revoked' | 'replayed'; endpoint: WebhookEndpointMetadata }
	| { outcome: 'conflict' }
	| { outcome: 'not_found' };

export interface WebhookListQuery {
	cursor: string | null;
	limit: number;
}

export interface WebhookListPage {
	items: readonly WebhookEndpointMetadata[];
	nextCursor: string | null;
}

export interface WebhookOutboxRow {
	organizationId: string;
	endpointId: string;
	auditEventId: string;
	envelopeId: string;
	eventType: string;
	payloadJson: string;
	endpointUrl: string;
	signingSecret: string;
	sealingKeyId: string | null;
	claimToken: string;
	status: 'processing';
	attempts: number;
	availableAt: string;
	lockedAt: string;
}

export interface ClaimWebhookDeliveriesCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	limit: number;
}

export interface CompleteWebhookDeliveryCommand {
	organizationId: string;
	endpointId: string;
	auditEventId: string;
	claimToken: string;
	deliveredAt: string;
	httpStatus: number;
}

export interface FailWebhookDeliveryCommand {
	organizationId: string;
	endpointId: string;
	auditEventId: string;
	claimToken: string;
	failedAt: string;
	/** When false the outbox row is terminal and must never be reclaimed. */
	retryable: boolean;
	nextAvailableAt: string;
	errorCode: string;
	httpStatus: number | null;
}

export interface WebhookSigningSecretRow {
	organizationId: string;
	endpointId: string;
	signingSecret: string;
	sealingKeyId: string | null;
}

export interface ResealWebhookSigningSecretCommand {
	organizationId: string;
	endpointId: string;
	previousSealingKeyId: string | null;
	signingSecret: string;
	sealingKeyId: string;
}

export interface WebhookDeliveryLogPage {
	items: readonly {
		id: string;
		eventType: string;
		status: 'delivered' | 'failed' | 'retrying';
		attempt: number;
		httpStatus: number | null;
		errorCode: string | null;
		occurredAt: string;
	}[];
	nextCursor: string | null;
}

export interface WebhookStore {
	createEndpoint(command: CreateWebhookEndpointCommand): Promise<CreateWebhookEndpointResult>;
	listEndpoints(organizationId: string, query: WebhookListQuery): Promise<WebhookListPage>;
	getEndpoint(organizationId: string, webhookId: string): Promise<WebhookEndpointMetadata | null>;
	revokeEndpoint(command: RevokeWebhookEndpointCommand): Promise<RevokeWebhookEndpointResult>;
	/**
	 * Claim due work under a unique lease. D1 and PostgreSQL must match:
	 * `attempts < WEBHOOK_MAX_ATTEMPTS`, and either a retryable
	 * `pending`/`failed` row that is due, or a stale `processing` lease.
	 * Non-retryable failures stay failed and are never reclaimed.
	 */
	claimPendingDeliveries(
		command: ClaimWebhookDeliveriesCommand
	): Promise<readonly WebhookOutboxRow[]>;
	readClaimedDelivery(
		organizationId: string,
		endpointId: string,
		auditEventId: string,
		claimToken: string
	): Promise<WebhookOutboxRow | null>;
	completeDelivery(
		command: CompleteWebhookDeliveryCommand
	): Promise<{ outcome: 'completed' | 'stale' }>;
	failDelivery(command: FailWebhookDeliveryCommand): Promise<{ outcome: 'failed' | 'stale' }>;
	listStaleSigningSecrets(
		activeSealingKeyId: string,
		limit: number
	): Promise<readonly WebhookSigningSecretRow[]>;
	resealSigningSecret(
		command: ResealWebhookSigningSecretCommand
	): Promise<{ outcome: 'resealed' | 'stale' }>;
	listDeliveryLogs(
		organizationId: string,
		webhookId: string,
		query: WebhookListQuery
	): Promise<WebhookDeliveryLogPage>;
}

export function boundWebhookClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_WEBHOOK_CLAIM_BATCH);
}

export function webhookCatalogEvents(): readonly string[] {
	return WEBHOOK_AUDIT_EVENT_TYPES;
}
