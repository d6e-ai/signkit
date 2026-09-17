import type { DraftActor } from './draft-repository';

export const MAX_DOCX_CONVERSION_CLAIM_BATCH: number = 10;
export type DocxConversionDirection = 'import' | 'export';
export type DocxConversionStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

export const DOCX_CONVERSION_ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
export const FALLBACK_DOCX_CONVERSION_ERROR_CODE: string = 'docx_conversion_failed';

export function sanitizeDocxConversionErrorCode(code: string): string {
	if (DOCX_CONVERSION_ERROR_CODE_PATTERN.test(code)) return code;
	return FALLBACK_DOCX_CONVERSION_ERROR_CODE;
}

export interface DocxConversionJobBase {
	id: string;
	envelopeId: string;
	requestKey: string;
	requestFingerprint: string;
	status: DocxConversionStatus;
	attempts: number;
	availableAt: string;
	retryable: boolean;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt?: string | null;
	lockedAt?: string | null;
}

export interface DocxImportJob extends DocxConversionJobBase {
	direction: 'import';
	sourceObjectKey: string;
	sourceSha256: string;
	sourceByteSize: number;
	targetPath: `documents/${string}.md`;
	expectedGeneration: number;
	actor: DraftActor;
	idempotencyKey: string;
	result: { generation: number; commitSha: string; archiveSha256: string } | null;
}

export interface DocxExportJob extends DocxConversionJobBase {
	direction: 'export';
	sourceCommitSha: string;
	sourceArchiveKey: string;
	sourceArchiveSha256: string;
	result: {
		objectKey: string;
		sha256: string;
		byteSize: number;
		skippedPdfCount: number;
	} | null;
}

export type DocxConversionJob = DocxImportJob | DocxExportJob;

export interface EnqueueDocxImportCommand {
	id: string;
	envelopeId: string;
	requestKey: string;
	requestFingerprint: string;
	sourceObjectKey: string;
	sourceSha256: string;
	sourceByteSize: number;
	targetPath: `documents/${string}.md`;
	expectedGeneration: number;
	actor: DraftActor;
	idempotencyKey: string;
	createdAt: string;
}

export interface EnqueueDocxExportCommand {
	id: string;
	envelopeId: string;
	requestKey: string;
	requestFingerprint: string;
	sourceCommitSha: string;
	sourceArchiveKey: string;
	sourceArchiveSha256: string;
	createdAt: string;
}

export type EnqueueDocxConversionResult =
	{ outcome: 'enqueued' | 'existing'; job: DocxConversionJob } | { outcome: 'conflict' };

export interface ClaimDocxConversionsCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	limit: number;
	jobId?: string;
}

export interface ClaimedDocxConversionJob {
	job: DocxConversionJob;
	claimToken: string;
	startedAt: string;
}

export interface CompleteDocxImportCommand {
	jobId: string;
	claimToken: string;
	attemptId: string;
	attemptNumber: number;
	startedAt: string;
	completedAt: string;
	resultGeneration: number;
	resultCommitSha: string;
	resultArchiveSha256: string;
}

export interface CompleteDocxExportCommand {
	jobId: string;
	claimToken: string;
	attemptId: string;
	attemptNumber: number;
	startedAt: string;
	completedAt: string;
	resultObjectKey: string;
	resultSha256: string;
	resultByteSize: number;
	resultSkippedPdfCount: number;
}

export interface FailDocxConversionCommand {
	jobId: string;
	claimToken: string;
	attemptId: string;
	attemptNumber: number;
	startedAt: string;
	failedAt: string;
	errorCode: string;
	retryable: boolean;
	nextAvailableAt: string;
}

export interface DocxConversionStore {
	enqueueImport(command: EnqueueDocxImportCommand): Promise<EnqueueDocxConversionResult>;
	enqueueExport(command: EnqueueDocxExportCommand): Promise<EnqueueDocxConversionResult>;
	claim(command: ClaimDocxConversionsCommand): Promise<readonly ClaimedDocxConversionJob[]>;
	completeImport(command: CompleteDocxImportCommand): Promise<boolean>;
	completeExport(command: CompleteDocxExportCommand): Promise<boolean>;
	fail(command: FailDocxConversionCommand): Promise<boolean>;
	find(jobId: string): Promise<DocxConversionJob | null>;
	findByRequestKey?(
		envelopeId: string,
		direction: DocxConversionDirection,
		requestKey: string
	): Promise<DocxConversionJob | null>;
}

export function boundDocxConversionClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_DOCX_CONVERSION_CLAIM_BATCH);
}
