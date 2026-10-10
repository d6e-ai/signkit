import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import type { PdfSealProfile } from './pdf-seal-provider';
import type { PdfSealValidationChecks } from './pdf-seal-validator';

export const PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES: number = 8;
export const PDF_SEAL_JOB_MAX_ATTEMPT_SEQUENCE: number = 2_147_483_647;
export const PDF_SEAL_JOB_MAX_CLAIM_BATCH: number = 10;
export const PDF_SEAL_JOB_RETRY_BASE_DELAY_MS: number = 30_000;
export const PDF_SEAL_JOB_RETRY_MAX_DELAY_MS: number = 60 * 60 * 1_000;
export const PDF_SEAL_JOB_PROVIDER_POLL_DELAY_MS: number = 5_000;
export const MAX_SEALED_PDF_BYTES: number = 64 * 1024 * 1024;
export const MAX_PDF_SEAL_VALIDATION_REPORT_BYTES: number = 64 * 1024;

export type PdfSealJobStatus = 'pending' | 'processing' | 'failed' | 'publication_ready';
export type PdfSealJobAction =
	'submit' | 'recover_submit' | 'poll_provider' | 'validate' | 'publish';

export interface PdfSealFrozenReference {
	jobId: string;
	envelopeId: string;
	operationId: string;
	validationId: string;
	sourceObjectKey: string;
	sourceSha256: string;
	sourceByteSize: number;
	requestedProfile: PdfSealProfile;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
}

export interface PdfSealSealedArtifact {
	objectKey: string;
	sha256: string;
	byteSize: number;
	achievedProfile: PdfSealProfile;
}

export interface PdfSealValidationEvidence {
	validatorReceiptId: string;
	checks: PdfSealValidationChecks;
	reportObjectKey: string;
	reportSha256: string;
	reportByteSize: number;
	validatedAt: string;
}

export interface PdfSealJob extends PdfSealFrozenReference {
	status: PdfSealJobStatus;
	nextAction: PdfSealJobAction;
	attemptSequence: number;
	retryFailures: number;
	availableAt: string;
	lockedAt: string | null;
	retryable: boolean | null;
	lastErrorCode: string | null;
	providerReceiptId: string | null;
	sealedArtifact: PdfSealSealedArtifact | null;
	validationEvidence: PdfSealValidationEvidence | null;
	createdAt: string;
	updatedAt: string;
	readyAt: string | null;
	failedAt: string | null;
}

export interface EnqueuePdfSealJobCommand extends PdfSealFrozenReference {
	createdAt: string;
}

export type EnqueuePdfSealJobResult =
	| { outcome: 'enqueued' | 'existing'; job: PdfSealJob }
	| { outcome: 'conflict' | 'source_mismatch' };

export interface ClaimPdfSealJobsCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	limit: number;
	jobId?: string;
}

export interface ClaimedPdfSealJob {
	job: PdfSealJob;
	claimToken: string;
	startedAt: string;
}

interface PdfSealAttemptCommand {
	jobId: string;
	claimToken: string;
	attemptId: string;
	attemptNumber: number;
	startedAt: string;
	finishedAt: string;
}

export interface RecordAmbiguousPdfSealSubmitCommand extends PdfSealAttemptCommand {
	kind: 'ambiguous_submit';
}

export interface RecordPdfSealProviderReceiptCommand extends PdfSealAttemptCommand {
	kind: 'provider_receipt';
	providerReceiptId: string;
}

export interface DeferPdfSealProviderCommand extends PdfSealAttemptCommand {
	kind: 'provider_pending';
	providerReceiptId: string;
}

export interface RecordPdfSealProviderResultCommand extends PdfSealAttemptCommand {
	kind: 'provider_result';
	providerReceiptId: string;
	sealedArtifact: PdfSealSealedArtifact;
}

export type PdfSealCheckpointCommand =
	| RecordAmbiguousPdfSealSubmitCommand
	| RecordPdfSealProviderReceiptCommand
	| DeferPdfSealProviderCommand
	| RecordPdfSealProviderResultCommand;

export interface CompletePdfSealJobCommand extends PdfSealAttemptCommand {
	providerReceiptId: string;
	sealedArtifact: PdfSealSealedArtifact;
	validationEvidence: PdfSealValidationEvidence;
}

export interface FailPdfSealJobCommand extends PdfSealAttemptCommand {
	errorCode: string;
	retryable: boolean;
}

export interface PdfSealJobStore {
	enqueue(command: EnqueuePdfSealJobCommand): Promise<EnqueuePdfSealJobResult>;
	claim(command: ClaimPdfSealJobsCommand): Promise<readonly ClaimedPdfSealJob[]>;
	checkpoint(command: PdfSealCheckpointCommand): Promise<boolean>;
	complete(command: CompletePdfSealJobCommand): Promise<boolean>;
	fail(command: FailPdfSealJobCommand): Promise<boolean>;
	find(jobId: string): Promise<PdfSealJob | null>;
	findByEnvelopeId(envelopeId: string): Promise<PdfSealJob | null>;
}

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const SAFE_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
const SAFE_OPAQUE_PATTERN: RegExp = /^[\x21-\x7e]{1,256}$/;
const SAFE_POLICY_PATTERN: RegExp = /^[\x21-\x7e]{1,128}$/;

export function assertValidPdfSealFrozenReference(reference: PdfSealFrozenReference): void {
	for (const [name, value] of [
		['jobId', reference.jobId],
		['envelopeId', reference.envelopeId],
		['operationId', reference.operationId],
		['validationId', reference.validationId]
	] as const) {
		if (!UUID_V7_PATTERN.test(value)) throw new TypeError(`${name} must be a UUIDv7`);
	}
	assertObjectKey(reference.sourceObjectKey, 'sourceObjectKey');
	assertDigest(reference.sourceSha256, 'sourceSha256');
	assertPositiveSize(
		reference.sourceByteSize,
		MAX_PUBLISHED_COMPLETION_PDF_BYTES,
		'sourceByteSize'
	);
	assertDigest(reference.signerCertificateSha256, 'signerCertificateSha256');
	assertPolicyId(reference.sealPolicyId, 'sealPolicyId');
	assertPolicyId(reference.validationPolicyId, 'validationPolicyId');
	if (reference.requestedProfile === 'pades-b-b') {
		if (reference.tsaPolicyId !== null || reference.tsaTrustBundleSha256 !== null) {
			throw new TypeError('pades-b-b must not include a TSA policy tuple');
		}
	} else if (reference.requestedProfile === 'pades-b-t') {
		if (reference.tsaPolicyId === null || reference.tsaTrustBundleSha256 === null) {
			throw new TypeError('pades-b-t requires the complete TSA policy tuple');
		}
		assertPolicyId(reference.tsaPolicyId, 'tsaPolicyId');
		assertDigest(reference.tsaTrustBundleSha256, 'tsaTrustBundleSha256');
	} else {
		throw new TypeError('requestedProfile is unsupported');
	}
}

export function assertValidPdfSealArtifact(
	artifact: PdfSealSealedArtifact,
	sourceByteSize: number,
	requestedProfile: PdfSealProfile
): void {
	assertObjectKey(artifact.objectKey, 'sealedArtifact.objectKey');
	assertDigest(artifact.sha256, 'sealedArtifact.sha256');
	assertPositiveSize(artifact.byteSize, MAX_SEALED_PDF_BYTES, 'sealedArtifact.byteSize');
	if (artifact.byteSize <= sourceByteSize) {
		throw new TypeError('sealedArtifact.byteSize must include an incremental update');
	}
	if (artifact.achievedProfile !== requestedProfile) {
		throw new TypeError('sealedArtifact.achievedProfile must equal requestedProfile');
	}
}

export function assertValidPdfSealValidationEvidence(
	evidence: PdfSealValidationEvidence,
	requestedProfile: PdfSealProfile
): void {
	assertSafeOpaque(evidence.validatorReceiptId, 'validatorReceiptId');
	assertObjectKey(evidence.reportObjectKey, 'validationEvidence.reportObjectKey');
	assertDigest(evidence.reportSha256, 'validationEvidence.reportSha256');
	assertPositiveSize(
		evidence.reportByteSize,
		MAX_PDF_SEAL_VALIDATION_REPORT_BYTES,
		'validationEvidence.reportByteSize'
	);
	assertIsoTimestamp(evidence.validatedAt, 'validationEvidence.validatedAt');
	if (evidence.checks.cmsSubFilter !== 'ETSI.CAdES.detached') {
		throw new TypeError('validationEvidence.checks has an invalid CMS profile');
	}
	for (const [name, value] of [
		['sourcePrefixExact', evidence.checks.sourcePrefixExact],
		['incrementalUpdateValid', evidence.checks.incrementalUpdateValid],
		['byteRangeComplete', evidence.checks.byteRangeComplete],
		['cmsSignatureValid', evidence.checks.cmsSignatureValid],
		['signerCertificateProtected', evidence.checks.signerCertificateProtected],
		['signerCertificateDigestMatches', evidence.checks.signerCertificateDigestMatches],
		['certificatePathValid', evidence.checks.certificatePathValid],
		['sealPolicyValid', evidence.checks.sealPolicyValid],
		['invisibleApprovalSignature', evidence.checks.invisibleApprovalSignature],
		['docMdpAbsent', evidence.checks.docMdpAbsent],
		['noPostSealChanges', evidence.checks.noPostSealChanges]
	] as const) {
		if (value !== true) throw new TypeError(`validationEvidence.checks.${name} must be true`);
	}
	if (requestedProfile === 'pades-b-t' && evidence.checks.timestamp === null) {
		throw new TypeError('pades-b-t validation evidence requires timestamp checks');
	}
	if (requestedProfile === 'pades-b-b' && evidence.checks.timestamp !== null) {
		throw new TypeError('pades-b-b validation evidence must not include timestamp checks');
	}
	if (evidence.checks.timestamp !== null) {
		for (const [name, value] of [
			['responseStatusGranted', evidence.checks.timestamp.responseStatusGranted],
			['messageImprintValid', evidence.checks.timestamp.messageImprintValid],
			['nonceValidWhenPresent', evidence.checks.timestamp.nonceValidWhenPresent],
			['policyValid', evidence.checks.timestamp.policyValid],
			['tokenSignatureValid', evidence.checks.timestamp.tokenSignatureValid],
			['certificatePathValid', evidence.checks.timestamp.certificatePathValid],
			['ekuCriticalTimeStampingOnly', evidence.checks.timestamp.ekuCriticalTimeStampingOnly],
			['essCertificateBindingValid', evidence.checks.timestamp.essCertificateBindingValid],
			['genTimeValid', evidence.checks.timestamp.genTimeValid]
		] as const) {
			if (value !== true) {
				throw new TypeError(`validationEvidence.checks.timestamp.${name} must be true`);
			}
		}
	}
}

export function assertPdfSealAttemptCommand(command: PdfSealAttemptCommand): void {
	if (!UUID_V7_PATTERN.test(command.jobId)) throw new TypeError('jobId must be a UUIDv7');
	if (!UUID_V7_PATTERN.test(command.attemptId)) throw new TypeError('attemptId must be a UUIDv7');
	assertSafeOpaque(command.claimToken, 'claimToken');
	if (
		!Number.isSafeInteger(command.attemptNumber) ||
		command.attemptNumber < 1 ||
		command.attemptNumber > PDF_SEAL_JOB_MAX_ATTEMPT_SEQUENCE
	) {
		throw new TypeError('attemptNumber is outside the supported range');
	}
	assertIsoTimestamp(command.startedAt, 'startedAt');
	assertIsoTimestamp(command.finishedAt, 'finishedAt');
	if (Date.parse(command.finishedAt) < Date.parse(command.startedAt)) {
		throw new TypeError('finishedAt must not precede startedAt');
	}
}

export function assertPdfSealErrorCode(errorCode: string): void {
	if (!SAFE_CODE_PATTERN.test(errorCode)) throw new TypeError('errorCode is not operator-safe');
}

export function assertPdfSealProviderReceipt(providerReceiptId: string): void {
	assertSafeOpaque(providerReceiptId, 'providerReceiptId');
}

export function boundPdfSealClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, PDF_SEAL_JOB_MAX_CLAIM_BATCH);
}

export function pdfSealRetryAvailableAt(failedAt: string, consecutiveFailures: number): string {
	assertIsoTimestamp(failedAt, 'failedAt');
	if (
		!Number.isSafeInteger(consecutiveFailures) ||
		consecutiveFailures < 1 ||
		consecutiveFailures > PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES
	) {
		throw new TypeError('consecutiveFailures is outside the supported range');
	}
	const delay: number = Math.min(
		PDF_SEAL_JOB_RETRY_BASE_DELAY_MS * 2 ** Math.min(consecutiveFailures - 1, 16),
		PDF_SEAL_JOB_RETRY_MAX_DELAY_MS
	);
	return new Date(Date.parse(failedAt) + delay).toISOString();
}

export function pdfSealProviderPollAvailableAt(finishedAt: string): string {
	assertIsoTimestamp(finishedAt, 'finishedAt');
	return new Date(Date.parse(finishedAt) + PDF_SEAL_JOB_PROVIDER_POLL_DELAY_MS).toISOString();
}

function assertDigest(value: string, name: string): void {
	if (!SHA256_PATTERN.test(value)) throw new TypeError(`${name} must be a lowercase SHA-256`);
}

function assertObjectKey(value: string, name: string): void {
	if (value.length < 1 || value.length > 1_024 || hasAsciiControl(value)) {
		throw new TypeError(`${name} is invalid`);
	}
}

function hasAsciiControl(value: string): boolean {
	for (let index: number = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function assertPolicyId(value: string, name: string): void {
	if (!SAFE_POLICY_PATTERN.test(value)) throw new TypeError(`${name} is invalid`);
}

function assertSafeOpaque(value: string, name: string): void {
	if (!SAFE_OPAQUE_PATTERN.test(value)) throw new TypeError(`${name} is invalid`);
}

function assertPositiveSize(value: number, maximum: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new TypeError(`${name} is outside the supported range`);
	}
}

function assertIsoTimestamp(value: string, name: string): void {
	const timestamp: number = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
		throw new TypeError(`${name} must be a canonical ISO timestamp`);
	}
}
