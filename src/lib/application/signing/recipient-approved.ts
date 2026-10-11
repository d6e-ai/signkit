import { hashAuditEventV3 } from '$lib/domain/audit';
import {
	envelopeCompletedAuditPayload,
	envelopeCompletedAuditPayloadJson,
	nextRoutingCapabilityExpiresAt,
	planRecipientDecisionRouting,
	type RecipientDecisionPlan
} from '$lib/domain/commands/recipient-decision-routing';
import {
	fingerprintRecipientApproveRequest,
	recipientApprovedAuditPayloadJson
} from '$lib/domain/commands/recipient-approve';
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
		const requestFingerprint: string = await fingerprintRecipientApproveRequest({
			envelopeId: input.expectedEnvelopeId,
			recipientId: input.expectedRecipientId,
			capabilityHash
		});
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
			const auditPayloadJson: string = recipientApprovedAuditPayloadJson({
				recipientId: preparation.recipientId,
				role: preparation.recipientRole,
				routingOrder: preparation.routingOrder,
				sentCommitSha: preparation.sentCommitSha,
				approvedAt
			});
			const auditEventHash: string = await hashAuditEventV3(
				{
					sequence: preparation.auditHead.sequence + 1,
					eventType: 'recipient.approved',
					actorType: 'recipient',
					actorId: preparation.recipientId,
					occurredAt: approvedAt,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				},
				{ envelopeId: preparation.envelopeId }
			);

			const routing: ApproveRoutingSnapshot = preparation.routing;
			const plan: RecipientDecisionPlan = planRecipientDecisionRouting(routing);

			let completedAuditEventId: string | null = null;
			let completedAuditEventHash: string | null = null;
			let completedAuditPayloadJson: string | null = null;
			let nextRoutingOrder: number | null = null;
			let nextCapabilityExpiresAt: string | null = null;
			let releasedDeliveryCount: number = 0;

			if (plan.kind === 'complete') {
				completedAuditEventId = this.newId();
				const completedPayloadValue = envelopeCompletedAuditPayload(
					preparation.sentCommitSha,
					approvedAt
				);
				completedAuditPayloadJson = envelopeCompletedAuditPayloadJson(
					preparation.sentCommitSha,
					approvedAt
				);
				completedAuditEventHash = await hashAuditEventV3(
					{
						sequence: preparation.auditHead.sequence + 2,
						eventType: 'envelope.completed',
						actorType: 'recipient',
						actorId: preparation.recipientId,
						occurredAt: approvedAt,
						payload: completedPayloadValue,
						previousHash: auditEventHash
					},
					{ envelopeId: preparation.envelopeId }
				);
			} else if (plan.kind === 'release') {
				nextRoutingOrder = plan.nextRoutingOrder;
				nextCapabilityExpiresAt = nextRoutingCapabilityExpiresAt(approvedAt);
				releasedDeliveryCount = plan.releasedDeliveryCount;
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
