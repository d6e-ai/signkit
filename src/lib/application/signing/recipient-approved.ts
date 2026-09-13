import { hashAuditEventV2 } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
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
	| { outcome: 'delivery_in_flight' }
	| { outcome: 'integrity_error' };

export interface RecipientApprovedApplicationPort {
	approve(input: RecipientApprovedInput): Promise<RecipientApprovedResult>;
}

export class RecipientApprovedApplication implements RecipientApprovedApplicationPort {
	constructor(
		private readonly store: RecipientApproveStore,
		private readonly now: () => Date = (): Date => new Date(),
		private readonly newId: UuidV7Generator = newUuidV7
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

			// Replay is proven by the durable command receipt and its audit
			// evidence, not by re-deriving this identifier, so each attempt mints a
			// fresh one.
			const auditEventId: string = this.newId();
			const auditPayloadJson: string = JSON.stringify({
				recipientId: preparation.recipientId,
				role: preparation.recipientRole,
				routingOrder: preparation.routingOrder,
				sentCommitSha: preparation.sentCommitSha,
				approvedAt
			});
			const auditEventHash: string = await hashAuditEventV2(
				{
					sequence: preparation.auditHead.sequence + 1,
					eventType: 'recipient.approved',
					actorType: 'recipient',
					actorId: preparation.recipientId,
					occurredAt: approvedAt,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				},
				{ organizationId: preparation.organizationId, envelopeId: preparation.envelopeId }
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
				completedAuditEventId = this.newId();
				const completedPayloadValue = {
					sentCommitSha: preparation.sentCommitSha,
					completedAt: approvedAt
				};
				completedAuditPayloadJson = JSON.stringify(completedPayloadValue);
				completedAuditEventHash = await hashAuditEventV2(
					{
						sequence: preparation.auditHead.sequence + 2,
						eventType: 'envelope.completed',
						actorType: 'recipient',
						actorId: preparation.recipientId,
						occurredAt: approvedAt,
						payload: completedPayloadValue,
						previousHash: auditEventHash
					},
					{ organizationId: preparation.organizationId, envelopeId: preparation.envelopeId }
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
