import type {
	ApproveCommandKey,
	ApprovePreparation,
	ApproveRoutingSnapshot,
	PublishRecipientApprovedCommand,
	PublishRecipientApprovedResult,
	PublishedRecipientApproved,
	RecipientApproveStore
} from '$lib/ports/recipient-approve-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';

const MAX_AUDIT_ATTEMPTS: number = 3;
const NEXT_ROUTING_CAPABILITY_TTL_MS: number = 14 * 24 * 60 * 60 * 1000;
const NUL: string = String.fromCharCode(0);

export interface RecipientApprovedInput {
	token: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	idempotencyKey: string;
}

export type RecipientApprovedResult =
	| { outcome: 'published' | 'replayed'; result: PublishedRecipientApproved }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'role_not_actionable' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface RecipientApprovedApplicationPort {
	approve(input: RecipientApprovedInput): Promise<RecipientApprovedResult>;
}

export class RecipientApprovedApplication implements RecipientApprovedApplicationPort {
	constructor(
		private readonly store: RecipientApproveStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async approve(input: RecipientApprovedInput): Promise<RecipientApprovedResult> {
		const capabilityHash: string = await hashRecipientCapability(input.token);
		const requestFingerprint: string = await sha256(
			JSON.stringify({
				envelopeId: input.expectedEnvelopeId,
				recipientId: input.expectedRecipientId,
				capabilityHash
			})
		);
		const key: ApproveCommandKey = {
			capabilityHash,
			expectedEnvelopeId: input.expectedEnvelopeId,
			expectedRecipientId: input.expectedRecipientId,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};

		for (let attempt: number = 0; attempt < MAX_AUDIT_ATTEMPTS; attempt += 1) {
			const approvedAt: string = this.now().toISOString();
			const preparation: ApprovePreparation = await this.store.prepareApproved(key, approvedAt);
			if (preparation.outcome !== 'ready') return preparation;

			const auditEventId: string = await deterministicUuid(
				[
					'signkit-recipient-approved-event-v1',
					preparation.organizationId,
					preparation.envelopeId,
					preparation.recipientId,
					input.idempotencyKey
				].join(NUL)
			);
			const auditPayloadJson: string = JSON.stringify({
				recipientId: preparation.recipientId,
				role: preparation.recipientRole,
				routingOrder: preparation.routingOrder,
				sentCommitSha: preparation.sentCommitSha,
				approvedAt
			});
			const auditEventHash: string = await sha256(
				JSON.stringify({
					actorId: preparation.recipientId,
					envelopeId: preparation.envelopeId,
					eventType: 'recipient.approved',
					occurredAt: approvedAt,
					organizationId: preparation.organizationId,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				})
			);

			const routing: ApproveRoutingSnapshot = preparation.routing;
			const shouldComplete: boolean = routing.remainingActionableOutstanding === 0;
			const shouldRelease: boolean =
				!shouldComplete &&
				routing.currentGroupOutstanding === 0 &&
				routing.nextRoutingOrder !== null;

			let completedAuditEventId: string | null = null;
			let completedAuditEventHash: string | null = null;
			let completedAuditPayloadJson: string | null = null;
			let nextRoutingOrder: number | null = null;
			let nextCapabilityExpiresAt: string | null = null;
			let releasedDeliveryCount: number = 0;

			if (shouldComplete) {
				completedAuditEventId = await deterministicUuid(
					[
						'signkit-envelope-completed-event-v1',
						preparation.organizationId,
						preparation.envelopeId,
						preparation.recipientId,
						input.idempotencyKey
					].join(NUL)
				);
				const completedPayloadValue = {
					sentCommitSha: preparation.sentCommitSha,
					completedAt: approvedAt
				};
				completedAuditPayloadJson = JSON.stringify(completedPayloadValue);
				completedAuditEventHash = await sha256(
					JSON.stringify({
						actorId: preparation.recipientId,
						envelopeId: preparation.envelopeId,
						eventType: 'envelope.completed',
						occurredAt: approvedAt,
						organizationId: preparation.organizationId,
						payload: completedPayloadValue,
						previousHash: auditEventHash
					})
				);
			} else if (shouldRelease) {
				nextRoutingOrder = routing.nextRoutingOrder;
				nextCapabilityExpiresAt = new Date(
					Date.parse(approvedAt) + NEXT_ROUTING_CAPABILITY_TTL_MS
				).toISOString();
				releasedDeliveryCount = routing.nextGroupCount;
			}

			const command: PublishRecipientApprovedCommand = {
				...key,
				recipientRole: 'approver',
				routingOrder: preparation.routingOrder,
				expectedSentCommitSha: preparation.sentCommitSha,
				updatedAt: approvedAt,
				nextRoutingOrder,
				nextCapabilityExpiresAt,
				releasedDeliveryCount,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				auditEventId,
				auditEventHash,
				auditPayloadJson,
				completedAuditEventId,
				completedAuditEventHash,
				completedAuditPayloadJson
			};
			const published: PublishRecipientApprovedResult = await this.store.publishApproved(command);
			if (published.outcome === 'audit_conflict' && attempt + 1 < MAX_AUDIT_ATTEMPTS) continue;
			return published;
		}

		return { outcome: 'audit_conflict' };
	}
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

async function deterministicUuid(value: string): Promise<string> {
	const digest: string = await sha256(value);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(
		17,
		20
	)}-${digest.slice(20, 32)}`;
}
