import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import {
	assertPdfSealProviderReceipt,
	assertValidPdfSealArtifact,
	assertValidPdfSealFrozenReference,
	assertValidPdfSealValidationEvidence,
	type PdfSealFrozenReference,
	type PdfSealSealedArtifact,
	type PdfSealValidationEvidence
} from './pdf-seal-job-store';
import type { PdfSealProfile } from './pdf-seal-provider';

export const MAX_PDF_SEAL_PUBLICATION_DISCOVERY_BATCH: number = 25;

export interface DiscoverPdfSealPublicationCandidatesCommand {
	limit: number;
}

/**
 * Deliberately minimal: the application layer re-reads and re-hashes the
 * full job and its evidence objects from `PdfSealJobStore` before calling
 * `publishPdfSeal`, rather than trusting anything carried by discovery.
 */
export interface PdfSealPublicationCandidate {
	jobId: string;
	envelopeId: string;
}

/**
 * The exact frozen job/evidence tuple plus the audit anchor, payload, and
 * hash the caller re-read and re-computed immediately before calling. No
 * external (provider/validator) call may happen inside the store
 * transaction this command drives — that re-read/re-hash already happened
 * in the caller before this command was built.
 */
export interface PublishPdfSealCommand extends PdfSealFrozenReference {
	providerReceiptId: string;
	sealedArtifact: PdfSealSealedArtifact;
	validationEvidence: PdfSealValidationEvidence;
	publishedAt: string;
	anchorAuditEventId: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export interface PublishedPdfSeal {
	jobId: string;
	envelopeId: string;
	sealedSha256: string;
	sealedByteSize: number;
	achievedProfile: PdfSealProfile;
	validationReportSha256: string;
	validatedAt: string;
	publishedAt: string;
	auditEventId: string;
}

/**
 * `stale` means the job itself is no longer exactly the `publication_ready`
 * / `publish` row with the frozen/evidence tuple the caller read — it is
 * not eligible for this publish anymore. `integrity_error` means the job
 * still matches, but the envelope, its source `completion_artifact_pdf`
 * row, or the supplied audit anchor no longer matches — evidence of
 * corruption or a structural conflict rather than ordinary staleness.
 */
export type PublishPdfSealResult =
	| { outcome: 'published'; result: PublishedPdfSeal }
	| { outcome: 'replayed'; result: PublishedPdfSeal }
	| { outcome: 'stale' }
	| { outcome: 'integrity_error' };

/**
 * The full internal publication row. Object keys and opaque provider/
 * validator receipts are present here for internal use (e.g. serving a
 * download or an internal status view) but must never be copied into an
 * audit payload or a public DTO by any caller.
 */
export interface PdfSealPublicationRecord extends PdfSealFrozenReference {
	providerReceiptId: string;
	sealedArtifact: PdfSealSealedArtifact;
	validationEvidence: PdfSealValidationEvidence;
	publishedAt: string;
	auditEventId: string;
	auditHeadSequence: number;
	auditHeadEventHash: string;
}

export interface PdfSealPublicationStore {
	discoverPdfSealPublicationCandidates(
		command: DiscoverPdfSealPublicationCandidatesCommand
	): Promise<readonly PdfSealPublicationCandidate[]>;
	publishPdfSeal(command: PublishPdfSealCommand): Promise<PublishPdfSealResult>;
	readPdfSealPublicationByEnvelope(envelopeId: string): Promise<PdfSealPublicationRecord | null>;
}

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;

export function assertValidPublishPdfSealCommand(command: PublishPdfSealCommand): void {
	assertValidPdfSealFrozenReference(command);
	assertValidPdfSealArtifact(
		command.sealedArtifact,
		command.sourceByteSize,
		command.requestedProfile
	);
	assertValidPdfSealValidationEvidence(command.validationEvidence, command.requestedProfile);
	assertPdfSealProviderReceipt(command.providerReceiptId);
	if (!UUID_V7_PATTERN.test(command.anchorAuditEventId)) {
		throw new TypeError('anchorAuditEventId must be a UUIDv7');
	}
	if (!UUID_V7_PATTERN.test(command.auditEventId)) {
		throw new TypeError('auditEventId must be a UUIDv7');
	}
	if (!Number.isSafeInteger(command.expectedAuditSequence) || command.expectedAuditSequence < 1) {
		throw new TypeError('expectedAuditSequence must be a positive integer');
	}
	if (!SHA256_PATTERN.test(command.previousAuditHash)) {
		throw new TypeError('previousAuditHash must be a lowercase SHA-256');
	}
	if (!SHA256_PATTERN.test(command.auditEventHash)) {
		throw new TypeError('auditEventHash must be a lowercase SHA-256');
	}
	assertCanonicalJson(command.auditPayloadJson);
	assertTimestamp(command.publishedAt, 'publishedAt');
	if (Date.parse(command.publishedAt) < Date.parse(command.validationEvidence.validatedAt)) {
		throw new TypeError('publishedAt must not precede validationEvidence.validatedAt');
	}
}

export function boundPdfSealPublicationDiscoveryLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_PDF_SEAL_PUBLICATION_DISCOVERY_BATCH);
}

function assertCanonicalJson(value: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError('auditPayloadJson must be valid JSON');
	}
	if (JSON.stringify(parsed) !== value) {
		throw new TypeError('auditPayloadJson must be canonical JSON');
	}
}

function assertTimestamp(value: string, name: string): void {
	const timestamp: number = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
		throw new TypeError(`${name} must be a canonical ISO timestamp`);
	}
}
