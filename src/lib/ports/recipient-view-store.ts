import type { RecipientRole } from '$lib/domain/envelope';

export interface ViewedCommandKey {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	capabilityHash: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface ViewedAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedRecipientViewed {
	envelopeId: string;
	recipientId: string;
	recipientRole: RecipientRole;
	routingOrder: number;
	sentCommitSha: string;
	envelopeStatus: 'in_progress';
	viewedAt: string;
	auditEventId: string;
}

export type ViewedPreparation =
	| {
			outcome: 'ready';
			recipientRole: RecipientRole;
			routingOrder: number;
			sentCommitSha: string;
			envelopeStatus: 'sent' | 'in_progress';
			auditHead: ViewedAuditHead;
	  }
	| { outcome: 'replayed'; result: PublishedRecipientViewed }
	| { outcome: 'continued'; result: PublishedRecipientViewed }
	| { outcome: 'not_found' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishRecipientViewedCommand extends ViewedCommandKey {
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

export type PublishRecipientViewedResult =
	| { outcome: 'published'; result: PublishedRecipientViewed }
	| Exclude<ViewedPreparation, { outcome: 'ready' }>;

export interface RecipientViewStore {
	prepareViewed(key: ViewedCommandKey, at: string): Promise<ViewedPreparation>;
	publishViewed(command: PublishRecipientViewedCommand): Promise<PublishRecipientViewedResult>;
}
