import type { RecipientRole } from '$lib/domain/envelope';

export interface DeclineCommandKey {
	capabilityHash: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface DeclineAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedRecipientDeclined {
	envelopeId: string;
	recipientId: string;
	recipientRole: RecipientRole;
	routingOrder: number;
	sentCommitSha: string;
	envelopeStatus: 'declined';
	declinedAt: string;
	auditEventId: string;
}

export type DeclinePreparation =
	| {
			outcome: 'ready';
			organizationId: string;
			envelopeId: string;
			recipientId: string;
			recipientRole: RecipientRole;
			routingOrder: number;
			sentCommitSha: string;
			envelopeStatus: 'sent' | 'in_progress';
			auditHead: DeclineAuditHead;
	  }
	| { outcome: 'replayed'; result: PublishedRecipientDeclined }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'role_not_actionable' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishRecipientDeclinedCommand extends DeclineCommandKey {
	recipientRole: RecipientRole;
	routingOrder: number;
	expectedSentCommitSha: string;
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishRecipientDeclinedResult =
	| { outcome: 'published'; result: PublishedRecipientDeclined }
	| Exclude<DeclinePreparation, { outcome: 'ready' }>;

export interface RecipientDeclineStore {
	prepareDeclined(key: DeclineCommandKey, at: string): Promise<DeclinePreparation>;
	publishDeclined(
		command: PublishRecipientDeclinedCommand
	): Promise<PublishRecipientDeclinedResult>;
}
