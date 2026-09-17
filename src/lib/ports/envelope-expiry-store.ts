export const MAX_ENVELOPE_EXPIRY_DISCOVERY_BATCH: number = 25;

export type ExpirableEnvelopeStatus = 'sent' | 'in_progress';

/**
 * An envelope is expirable when it is `sent` or `in_progress` and every
 * actionable (signer/approver) recipient that has ever been released
 * (`capability_expires_at IS NOT NULL`) and has not yet acted (`pending` or
 * `viewed`) now has an expired capability, with at least one such recipient.
 * A recipient in a later, not-yet-released routing group (`capability_expires_at
 * IS NULL`) never blocks or triggers expiry on its own — release, not
 * expiry, is what makes a reserved group resolvable.
 */
export interface ExpirableEnvelopeId {
	envelopeId: string;
}

export interface DiscoverExpirableEnvelopesCommand {
	now: string;
	limit: number;
}

export interface EnvelopeExpiryAuditHead {
	sequence: number;
	eventHash: string;
}

export type EnvelopeExpiryPreparation =
	| {
			outcome: 'ready';
			envelopeId: string;
			previousStatus: ExpirableEnvelopeStatus;
			generation: number;
			repositoryHead: string | null;
			sentCommitSha: string | null;
			auditHead: EnvelopeExpiryAuditHead;
			revokedRecipientIds: readonly string[];
	  }
	| { outcome: 'not_eligible' }
	| { outcome: 'integrity_error' };

export interface PublishEnvelopeExpiryCommand {
	envelopeId: string;
	expectedStatus: ExpirableEnvelopeStatus;
	expectedGeneration: number;
	repositoryHead: string | null;
	sentCommitSha: string | null;
	expectedAuditSequence: number;
	previousAuditHash: string;
	revokedRecipientIds: readonly string[];
	expiredAt: string;
	auditEventId: string;
	auditPayloadJson: string;
	auditEventHash: string;
}

export interface PublishedEnvelopeExpiry {
	envelopeId: string;
	expiredAt: string;
	revokedCapabilityCount: number;
	auditEventId: string;
}

export type PublishEnvelopeExpiryResult =
	| { outcome: 'published'; result: PublishedEnvelopeExpiry }
	| { outcome: 'not_eligible' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface EnvelopeExpiryStore {
	discoverExpirableEnvelopes(
		command: DiscoverExpirableEnvelopesCommand
	): Promise<readonly ExpirableEnvelopeId[]>;
	prepareEnvelopeExpiry(envelopeId: string, now: string): Promise<EnvelopeExpiryPreparation>;
	publishEnvelopeExpiry(
		command: PublishEnvelopeExpiryCommand
	): Promise<PublishEnvelopeExpiryResult>;
}

export function boundEnvelopeExpiryDiscoveryLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_ENVELOPE_EXPIRY_DISCOVERY_BATCH);
}
