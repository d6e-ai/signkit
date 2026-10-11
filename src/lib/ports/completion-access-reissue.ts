import type { CurrentCompletionDeliveryRow } from './completion-access-reissue-row';

export interface ReissueCommandKey {
	envelopeId: string;
	recipientId: string;
	predecessorDeliveryId: string;
	actorType: 'user' | 'agent';
	actorId: string;
	idempotencyKey: string;
	requestHash: string;
}

export interface ExpectedPredecessorGeneration {
	expectedAttempts: number;
	expectedFailedAt: string;
	expectedErrorCode: string;
}

export interface ReissueAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedCompletionAccessReissue {
	envelopeId: string;
	recipientId: string;
	deliveryId: string;
	generation: number;
	accessExpiresAt: string;
	reissuedAt: string;
	auditEventId: string;
}

export type ReissueOutcome =
	| 'ready'
	| 'replayed'
	| 'not_found'
	| 'not_eligible'
	| 'stale_generation'
	| 'idempotency_conflict'
	| 'integrity_error';

export type PublishReissueOutcome = 'published' | Exclude<ReissueOutcome, 'ready'>;

export type NotEligibleReason =
	'envelope_not_completed' | 'recipient_not_eligible' | 'predecessor_not_exhausted';

export interface CompletionAccessReissuePreparationOutcome {
	outcome: ReissueOutcome;
	predecessorGeneration?: number;
	auditHead?: ReissueAuditHead;
	result?: PublishedCompletionAccessReissue;
	notEligibleReason?: NotEligibleReason;
}

export interface PublishCompletionAccessReissueOutcome {
	outcome: PublishReissueOutcome;
	result?: PublishedCompletionAccessReissue;
	notEligibleReason?: NotEligibleReason;
}

export interface PublishCompletionAccessReissueCommand
	extends ReissueCommandKey, ExpectedPredecessorGeneration {
	newDeliveryId: string;
	newTokenHash: string;
	newAccessExpiresAt: string;
	sealedToken: string;
	sealingKeyId: string;
	sealedTokenSha256: string;
	reissuedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
	/**
	 * The completion manifest and PDF digests the caller verified against
	 * object storage, outside this transaction, immediately before building
	 * this command. The publish-time lock rechecks these against the current
	 * `completion_artifact` / `completion_artifact_pdf` rows -- never against
	 * object storage again -- so a repair that replaces the artifact mid-flight
	 * is caught without doing object-storage IO under the lock.
	 */
	expectedJsonSha256: string;
	expectedMarkdownSha256: string;
	expectedPdfSha256: string;
}

export interface CompletionAccessReissueStore {
	listCurrentDeliveries(envelopeId: string): Promise<readonly CurrentCompletionDeliveryRow[]>;
	prepareReissue(
		key: ReissueCommandKey,
		expected: ExpectedPredecessorGeneration
	): Promise<CompletionAccessReissuePreparationOutcome>;
	publishReissue(
		command: PublishCompletionAccessReissueCommand
	): Promise<PublishCompletionAccessReissueOutcome>;
}

/**
 * The two outcomes a durable idempotency-key lookup alone can ever resolve
 * to. Deliberately narrower than both {@link CompletionAccessReissuePreparationOutcome}
 * and {@link PublishCompletionAccessReissueOutcome} (neither of which a
 * lookup-only resolver can ever produce 'ready' or 'published' from) so an
 * adapter can return it directly as either without a cast.
 */
export type ReissueReplayOutcome =
	| { outcome: 'replayed'; result: PublishedCompletionAccessReissue }
	| { outcome: 'idempotency_conflict' };

/**
 * Reclassifies a read-side preparation outcome as a publish outcome once the
 * caller has already ruled out `'ready'` (a write that aborted while every
 * preparation predicate still passed is an `integrity_error`, never a
 * silent success). An exhaustive `switch` on the literal `outcome`, not a
 * structural return of the original object -- the two outcome unions are
 * nominally different types that happen to share every member except
 * `'ready'` / `'published'`.
 */
export function publishOutcomeFromPreparation(
	preparation: CompletionAccessReissuePreparationOutcome
): PublishCompletionAccessReissueOutcome {
	switch (preparation.outcome) {
		case 'ready':
			return { outcome: 'integrity_error' };
		case 'replayed':
			return preparation.result === undefined
				? { outcome: 'integrity_error' }
				: { outcome: 'replayed', result: preparation.result };
		case 'not_found':
			return { outcome: 'not_found' };
		case 'not_eligible':
			return { outcome: 'not_eligible', notEligibleReason: preparation.notEligibleReason };
		case 'stale_generation':
			return { outcome: 'stale_generation' };
		case 'idempotency_conflict':
			return { outcome: 'idempotency_conflict' };
		case 'integrity_error':
			return { outcome: 'integrity_error' };
	}
}
