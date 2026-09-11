export interface ApproveCommandKey {
	capabilityHash: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface ApproveAuditHead {
	sequence: number;
	eventHash: string;
}

export interface ApproveRoutingSnapshot {
	currentGroupOutstanding: number;
	remainingActionableOutstanding: number;
	nextRoutingOrder: number | null;
	nextGroupCount: number;
}

export interface PublishedRecipientApproved {
	envelopeId: string;
	recipientId: string;
	recipientRole: 'approver';
	routingOrder: number;
	sentCommitSha: string;
	envelopeStatus: 'in_progress' | 'completed';
	approvedAt: string;
	auditEventId: string;
	completedAuditEventId: string | null;
	nextRoutingOrder: number | null;
}

export type ApprovePreparation =
	| {
			outcome: 'ready';
			organizationId: string;
			envelopeId: string;
			recipientId: string;
			recipientRole: 'approver';
			routingOrder: number;
			sentCommitSha: string;
			envelopeStatus: 'sent' | 'in_progress';
			auditHead: ApproveAuditHead;
			routing: ApproveRoutingSnapshot;
	  }
	| { outcome: 'replayed'; result: PublishedRecipientApproved }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'role_not_actionable' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishRecipientApprovedCommand extends ApproveCommandKey {
	recipientRole: 'approver';
	routingOrder: number;
	expectedSentCommitSha: string;
	updatedAt: string;
	nextRoutingOrder: number | null;
	nextCapabilityExpiresAt: string | null;
	releasedDeliveryCount: number;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
}

export type PublishRecipientApprovedResult =
	| { outcome: 'published'; result: PublishedRecipientApproved }
	| Exclude<ApprovePreparation, { outcome: 'ready' }>;

export interface RecipientApproveStore {
	prepareApproved(key: ApproveCommandKey, at: string): Promise<ApprovePreparation>;
	publishApproved(
		command: PublishRecipientApprovedCommand
	): Promise<PublishRecipientApprovedResult>;
}
