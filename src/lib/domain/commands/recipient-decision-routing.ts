import { hashStoredAuditEvent } from '$lib/domain/audit';
import {
	isActionableRecipientRole,
	isPostSendInvitationRecipientRole,
	type RecipientRole
} from '$lib/domain/envelope';

export const NEXT_ROUTING_CAPABILITY_TTL_MS: number = 14 * 24 * 60 * 60 * 1000;
export const MAX_RELEASE_TTL_MS: number = 15 * 24 * 60 * 60 * 1000;

export interface RecipientDecisionRoutingRecipient {
	id: string;
	role: string;
	status: string;
	routingOrder: number;
}

export interface RecipientDecisionRoutingSnapshot {
	currentGroupOutstanding: number;
	remainingActionableOutstanding: number;
	nextRoutingOrder: number | null;
	nextGroupCount: number;
}

export type RecipientDecisionPlan =
	| { kind: 'complete' }
	| { kind: 'release'; nextRoutingOrder: number; releasedDeliveryCount: number }
	| { kind: 'continue' };

export interface EnvelopeCompletedAuditPayload {
	sentCommitSha: string;
	completedAt: string;
}

export interface RecipientDecisionCommandRouting {
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
	nextRoutingOrder: number | null;
	nextCapabilityExpiresAt: string | null;
	releasedDeliveryCount: number;
	updatedAt: string;
}

export interface StoredDecisionFollowThroughInput {
	envelopeId: string;
	recipientId: string;
	sentCommitSha: string;
	occurredAt: string;
	actorType: string;
	auditEventHash: string;
	auditSequence: number;
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
	completedEvidenceHashVersion: number | string | null;
	nextRoutingOrder: number | null;
	nextCapabilityExpiresAt: string | null;
	releasedDeliveryCount: number;
}

/**
 * Pure routing snapshot after the actor's own outstanding action is removed.
 * Viewer/cc/prefill never increment remaining actionable counts; viewers in
 * the next group still consume a post-send invitation slot.
 */
export function recipientDecisionRoutingSnapshot(
	actorId: string,
	actorRoutingOrder: number,
	recipients: readonly RecipientDecisionRoutingRecipient[]
): RecipientDecisionRoutingSnapshot {
	const remainingActionable: RecipientDecisionRoutingRecipient[] = recipients.filter(
		(recipient: RecipientDecisionRoutingRecipient): boolean =>
			recipient.id !== actorId &&
			isActionableRecipientRole(recipient.role as RecipientRole) &&
			recipient.status !== 'completed'
	);
	const laterOrders: number[] = remainingActionable
		.filter(
			(recipient: RecipientDecisionRoutingRecipient): boolean =>
				recipient.routingOrder > actorRoutingOrder
		)
		.map((recipient: RecipientDecisionRoutingRecipient): number => recipient.routingOrder);
	const nextRoutingOrder: number | null =
		laterOrders.length === 0 ? null : Math.min(...laterOrders);
	return {
		currentGroupOutstanding: remainingActionable.filter(
			(recipient: RecipientDecisionRoutingRecipient): boolean =>
				recipient.routingOrder === actorRoutingOrder
		).length,
		remainingActionableOutstanding: remainingActionable.length,
		nextRoutingOrder,
		nextGroupCount:
			nextRoutingOrder === null
				? 0
				: recipients.filter(
						(recipient: RecipientDecisionRoutingRecipient): boolean =>
							recipient.id !== actorId &&
							isPostSendInvitationRecipientRole(recipient.role as RecipientRole) &&
							recipient.status !== 'completed' &&
							recipient.routingOrder === nextRoutingOrder
					).length
	};
}

export function planRecipientDecisionRouting(
	routing: RecipientDecisionRoutingSnapshot
): RecipientDecisionPlan {
	if (routing.remainingActionableOutstanding === 0) {
		return { kind: 'complete' };
	}
	if (routing.currentGroupOutstanding === 0 && routing.nextRoutingOrder !== null) {
		return {
			kind: 'release',
			nextRoutingOrder: routing.nextRoutingOrder,
			releasedDeliveryCount: routing.nextGroupCount
		};
	}
	return { kind: 'continue' };
}

export function envelopeCompletedAuditPayload(
	sentCommitSha: string,
	completedAt: string
): EnvelopeCompletedAuditPayload {
	return {
		sentCommitSha,
		completedAt
	};
}

export function envelopeCompletedAuditPayloadJson(
	sentCommitSha: string,
	completedAt: string
): string {
	return JSON.stringify(envelopeCompletedAuditPayload(sentCommitSha, completedAt));
}

export function nextRoutingCapabilityExpiresAt(decidedAt: string): string {
	return new Date(Date.parse(decidedAt) + NEXT_ROUTING_CAPABILITY_TTL_MS).toISOString();
}

export function commandMatchesRecipientDecisionRouting(
	command: RecipientDecisionCommandRouting,
	routing: RecipientDecisionRoutingSnapshot
): boolean {
	const plan: RecipientDecisionPlan = planRecipientDecisionRouting(routing);
	if (plan.kind === 'complete') {
		return (
			command.completedAuditEventId !== null &&
			command.completedAuditEventHash !== null &&
			command.completedAuditPayloadJson !== null &&
			command.nextRoutingOrder === null &&
			command.nextCapabilityExpiresAt === null &&
			command.releasedDeliveryCount === 0
		);
	}
	if (plan.kind === 'release') {
		return (
			command.completedAuditEventId === null &&
			command.completedAuditEventHash === null &&
			command.completedAuditPayloadJson === null &&
			command.nextRoutingOrder === plan.nextRoutingOrder &&
			command.nextCapabilityExpiresAt !== null &&
			new Date(command.nextCapabilityExpiresAt).getTime() > new Date(command.updatedAt).getTime() &&
			new Date(command.nextCapabilityExpiresAt).getTime() <=
				new Date(command.updatedAt).getTime() + MAX_RELEASE_TTL_MS &&
			command.releasedDeliveryCount === plan.releasedDeliveryCount
		);
	}
	return (
		command.completedAuditEventId === null &&
		command.completedAuditEventHash === null &&
		command.completedAuditPayloadJson === null &&
		command.nextRoutingOrder === null &&
		command.nextCapabilityExpiresAt === null &&
		command.releasedDeliveryCount === 0
	);
}

export async function validStoredDecisionFollowThrough(
	input: StoredDecisionFollowThroughInput
): Promise<boolean> {
	if (input.completedAuditEventId !== null) {
		if (
			input.nextRoutingOrder !== null ||
			input.nextCapabilityExpiresAt !== null ||
			input.releasedDeliveryCount !== 0 ||
			input.completedAuditEventHash === null ||
			input.completedAuditPayloadJson === null
		) {
			return false;
		}
		const completedPayloadValue: EnvelopeCompletedAuditPayload = envelopeCompletedAuditPayload(
			input.sentCommitSha,
			input.occurredAt
		);
		const completedPayload: string = JSON.stringify(completedPayloadValue);
		const completedEventHash: string = await hashStoredAuditEvent(
			{
				hashVersion: input.completedEvidenceHashVersion,
				sequence: input.auditSequence + 1,
				eventType: 'envelope.completed',
				actorType: input.actorType,
				actorId: input.recipientId,
				occurredAt: input.occurredAt,
				payload: completedPayloadValue,
				previousHash: input.auditEventHash
			},
			{ envelopeId: input.envelopeId }
		);
		return (
			completedPayload === input.completedAuditPayloadJson &&
			completedEventHash === input.completedAuditEventHash
		);
	}
	if (input.nextRoutingOrder !== null) {
		return (
			input.nextCapabilityExpiresAt !== null &&
			input.releasedDeliveryCount > 0 &&
			input.completedAuditEventHash === null &&
			input.completedAuditPayloadJson === null
		);
	}
	return (
		input.nextCapabilityExpiresAt === null &&
		input.releasedDeliveryCount === 0 &&
		input.completedAuditEventHash === null &&
		input.completedAuditPayloadJson === null
	);
}
