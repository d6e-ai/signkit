import type { FieldType, RecipientRole, RecipientStatus } from '$lib/domain/envelope';

export const MAX_COMPLETION_ARTIFACT_CLAIM_BATCH: number = 10;
export const MAX_COMPLETION_ARTIFACT_DISCOVERY_BATCH: number = 25;
export const COMPLETION_ARTIFACT_ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
export const FALLBACK_COMPLETION_ARTIFACT_ERROR_CODE: string = 'completion_artifact_failed';
/** Bounded audit read: stores fetch at most this many rows plus one to detect overflow. */
export const MAX_COMPLETION_AUDIT_VERIFY_EVENTS: number = 5_000;

/**
 * Raised whenever completion evidence fails a fail-closed integrity check —
 * an unrecomputable audit hash, a non-canonical or tampered timestamp, a
 * field/decision cross-check mismatch, and so on. Shared across adapters and
 * the application layer so a store can fail closed at read time and the
 * publication service can classify the failure the same way regardless of
 * where it was raised.
 */
export class CompletionArtifactIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CompletionArtifactIntegrityError';
	}
}

/**
 * A `CompletionArtifactIntegrityError` raised specifically because a resource
 * bound was exceeded — a document/recipient/field/event count, the aggregate
 * audit payload byte budget, or a manifest source/gzip byte limit — rather
 * than because evidence failed to verify. Callers that catch
 * `CompletionArtifactIntegrityError` still catch this (it is a subclass), but
 * the publication service checks `instanceof CompletionArtifactBoundExceededError`
 * first so it can publish the operator-safe `completion_artifact_evidence_too_large`
 * error code instead of `completion_artifact_evidence_invalid`: an oversized
 * envelope is an operational scaling signal, not proof of tampering.
 */
export class CompletionArtifactBoundExceededError extends CompletionArtifactIntegrityError {
	constructor(message: string) {
		super(message);
		this.name = 'CompletionArtifactBoundExceededError';
	}
}

/** Canonical ISO-8601 UTC timestamp at exactly millisecond precision, e.g. `2026-09-12T00:00:00.123Z`. */
export const ISO_MILLISECOND_TIMESTAMP_PATTERN: RegExp =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Every current writer stamps audit event timestamps with `Date#toISOString()`,
 * which is always millisecond precision. A stored value with any other shape —
 * missing the `Z` suffix, an offset, extra or fewer fractional digits — did not
 * come from the application and must fail closed rather than be silently
 * accepted into a hash preimage.
 */
export function requireCanonicalIsoMillisecondTimestamp(value: string): string {
	if (!ISO_MILLISECOND_TIMESTAMP_PATTERN.test(value)) {
		throw new CompletionArtifactIntegrityError(
			'Audit event timestamp is not a canonical ISO-8601 millisecond UTC string'
		);
	}
	return value;
}

export interface ClaimCompletionArtifactsCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	discoveryLimit: number;
	claimLimit: number;
}

export interface ClaimedCompletionArtifactJob {
	organizationId: string;
	envelopeId: string;
	attempts: number;
	lockedAt: string;
	envelopeTitle: string;
	sentCommitSha: string;
	repositoryArchiveKey: string;
	repositoryArchiveSha256: string;
	fieldGeneration: number;
}

export interface ReadClaimedCompletionArtifactCommand {
	organizationId: string;
	envelopeId: string;
	claimToken: string;
}

export interface CompletionEvidenceRecipient {
	id: string;
	role: RecipientRole;
	routingOrder: number;
	status: RecipientStatus;
	decisionEventId: string | null;
	decisionOccurredAt: string | null;
}

export interface CompletionEvidenceField {
	id: string;
	fieldType: FieldType;
	/**
	 * Internal only: the persisted `field_value.value_json` payload. Recomputed
	 * against `valueSha256` before any artifact object write and never exposed
	 * in a manifest, Markdown rendering, audit payload, status, response, log,
	 * or error message.
	 */
	valueJson: string;
	valueSha256: string;
}

export interface CompletionEvidenceAuditEvent {
	id: string;
	sequence: number;
	eventType: string;
	/**
	 * Not part of every event's hash preimage (only `draft.revision_created`
	 * hashes it) but always validated against the event type's expected actor
	 * semantics, since it could otherwise be altered without invalidating the
	 * event's own recomputed hash.
	 */
	actorType: string;
	actorId: string | null;
	/** Must be canonical (`JSON.stringify(JSON.parse(payloadJson)) === payloadJson`); verified before use. */
	payloadJson: string;
	previousHash: string | null;
	eventHash: string;
	/** Canonical ISO-8601 millisecond UTC; the adapter fails closed rather than silently truncate stray precision. */
	occurredAt: string;
}

export interface CompletionEvidence {
	recipients: readonly CompletionEvidenceRecipient[];
	fields: readonly CompletionEvidenceField[];
	auditEvents: readonly CompletionEvidenceAuditEvent[];
}

export interface PublishCompletionArtifactCommand {
	organizationId: string;
	envelopeId: string;
	claimToken: string;
	sentCommitSha: string;
	fieldGeneration: number;
	anchorAuditEventId: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	manifestSha256: string;
	jsonObjectKey: string;
	jsonSha256: string;
	markdownObjectKey: string;
	markdownSha256: string;
	updatedAt: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export interface PublishedCompletionArtifact {
	envelopeId: string;
	manifestSha256: string;
	jsonSha256: string;
	markdownSha256: string;
	publishedAt: string;
	auditEventId: string;
}

export type PublishCompletionArtifactResult =
	| { outcome: 'published'; result: PublishedCompletionArtifact }
	| { outcome: 'replayed'; result: PublishedCompletionArtifact }
	| { outcome: 'stale' }
	| { outcome: 'integrity_error' };

export interface FailCompletionArtifactCommand {
	organizationId: string;
	envelopeId: string;
	claimToken: string;
	errorCode: string;
	retryable: boolean;
	nextAvailableAt: string;
	failedAt: string;
}

export type FailCompletionArtifactResult = { outcome: 'failed' } | { outcome: 'stale' };

export type CompletionArtifactJobStatus = 'pending' | 'processing' | 'published' | 'failed';

export interface CompletionArtifactStatusRow {
	envelopeId: string;
	/** Whether the envelope itself has reached `completed`, independent of whether a job row has been discovered yet. */
	envelopeCompleted: boolean;
	jobStatus: CompletionArtifactJobStatus | null;
	attempts: number | null;
	lastError: string | null;
	availableAt: string | null;
	published: PublishedCompletionArtifact | null;
}

export interface CompletionArtifactStore {
	claimPendingCompletionArtifacts(
		command: ClaimCompletionArtifactsCommand
	): Promise<readonly ClaimedCompletionArtifactJob[]>;
	readClaimedCompletionArtifact(
		command: ReadClaimedCompletionArtifactCommand
	): Promise<ClaimedCompletionArtifactJob | null>;
	readCompletionEvidence(organizationId: string, envelopeId: string): Promise<CompletionEvidence>;
	publishCompletionArtifact(
		command: PublishCompletionArtifactCommand
	): Promise<PublishCompletionArtifactResult>;
	failCompletionArtifact(
		command: FailCompletionArtifactCommand
	): Promise<FailCompletionArtifactResult>;
	findCompletionArtifactStatus(
		organizationId: string,
		envelopeId: string
	): Promise<CompletionArtifactStatusRow | null>;
}

export function sanitizeCompletionArtifactErrorCode(code: string): string {
	if (COMPLETION_ARTIFACT_ERROR_CODE_PATTERN.test(code)) return code;
	return FALLBACK_COMPLETION_ARTIFACT_ERROR_CODE;
}

export function boundCompletionArtifactClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_COMPLETION_ARTIFACT_CLAIM_BATCH);
}
