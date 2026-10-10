import type { CompletionArtifactPdfMetadata } from './completion-artifact-store';

export const MAX_COMPLETION_ARTIFACT_PDF_REPAIR_CLAIM_BATCH: number = 1;
export const MAX_COMPLETION_ARTIFACT_PDF_REPAIR_DISCOVERY_BATCH: number = 25;
export const EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR: string =
	'completion_artifact_pdf_repair_attempts_exhausted';

export type CompletionArtifactPdfRepairJobStatus = 'pending' | 'processing' | 'repaired' | 'failed';

export interface ClaimCompletionArtifactPdfRepairsCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	discoveryLimit: number;
	claimLimit: number;
}

export interface ClaimedCompletionArtifactPdfRepair {
	envelopeId: string;
	attempts: number;
	lockedAt: string;
	envelopeTitle: string;
	sentCommitSha: string | null;
	repositoryArchiveKey: string | null;
	repositoryArchiveSha256: string | null;
	fieldGeneration: number;
	manifestSha256: string;
	jsonObjectKey: string;
	jsonSha256: string;
	markdownObjectKey: string;
	markdownSha256: string;
	anchorAuditEventId: string;
	auditHeadSequence: number;
	auditHeadEventHash: string;
	auditEventId: string;
	publishedAt: string;
}

export interface ReadClaimedCompletionArtifactPdfRepairCommand {
	envelopeId: string;
	claimToken: string;
}

export interface CompleteCompletionArtifactPdfRepairCommand {
	envelopeId: string;
	claimToken: string;
	expectedManifestSha256: string;
	pdf: CompletionArtifactPdfMetadata;
	updatedAt: string;
}

export type CompleteCompletionArtifactPdfRepairResult =
	| { outcome: 'repaired' }
	| { outcome: 'replayed' }
	| { outcome: 'stale' }
	| { outcome: 'integrity_error' };

export interface FailCompletionArtifactPdfRepairCommand {
	envelopeId: string;
	claimToken: string;
	errorCode: string;
	retryable: boolean;
	nextAvailableAt: string;
	failedAt: string;
}

export type FailCompletionArtifactPdfRepairResult = { outcome: 'failed' } | { outcome: 'stale' };

/** See `RequeueExhaustedCompletionArtifactCommand` for the generation rule. */
export interface RequeueExhaustedCompletionArtifactPdfRepairCommand {
	envelopeId: string;
	idempotencyKey: string;
	expectedAttempts: number;
	expectedFailedAt: string;
	requeuedAt: string;
}

export type RequeueExhaustedCompletionArtifactPdfRepairResult =
	| { outcome: 'requeued' }
	| { outcome: 'replayed' }
	| { outcome: 'conflict' }
	| { outcome: 'not_eligible' }
	| { outcome: 'not_found' };

export interface CompletionArtifactPdfRepairStatusRow {
	envelopeId: string;
	status: CompletionArtifactPdfRepairJobStatus;
	attempts: number;
	lastError: string | null;
	availableAt: string | null;
	/** A failed row with `retryable` is a scheduled retry, not a terminal failure. */
	retryable: boolean;
	/** For a failed row this is the failure generation. */
	updatedAt: string;
}

export interface CompletionArtifactPdfRepairStore {
	claimPendingPdfRepairs(
		command: ClaimCompletionArtifactPdfRepairsCommand
	): Promise<readonly ClaimedCompletionArtifactPdfRepair[]>;
	readClaimedPdfRepair(
		command: ReadClaimedCompletionArtifactPdfRepairCommand
	): Promise<ClaimedCompletionArtifactPdfRepair | null>;
	completePdfRepair(
		command: CompleteCompletionArtifactPdfRepairCommand
	): Promise<CompleteCompletionArtifactPdfRepairResult>;
	failPdfRepair(
		command: FailCompletionArtifactPdfRepairCommand
	): Promise<FailCompletionArtifactPdfRepairResult>;
	requeueExhaustedPdfRepair(
		command: RequeueExhaustedCompletionArtifactPdfRepairCommand
	): Promise<RequeueExhaustedCompletionArtifactPdfRepairResult>;
	findPdfRepairStatus(envelopeId: string): Promise<CompletionArtifactPdfRepairStatusRow | null>;
}

export function boundCompletionArtifactPdfRepairClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_COMPLETION_ARTIFACT_PDF_REPAIR_CLAIM_BATCH);
}
