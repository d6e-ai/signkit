import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import type { PdfSealProfile } from './pdf-seal-provider';

export interface PdfSealRequestActor {
	type: 'user' | 'agent';
	id: string;
}

export interface RequestPdfSealCommand {
	actor: PdfSealRequestActor;
	idempotencyKey: string;
	requestHash: string;
	envelopeId: string;
	jobId: string;
	operationId: string;
	validationId: string;
	requestedProfile: PdfSealProfile;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
	requestedAt: string;
}

export interface PublicPdfSealJobSummary {
	jobId: string;
	envelopeId: string;
	requestedProfile: PdfSealProfile;
	requestedAt: string;
}

export type RequestPdfSealResult =
	| { outcome: 'requested'; job: PublicPdfSealJobSummary }
	| { outcome: 'replayed'; job: PublicPdfSealJobSummary }
	| { outcome: 'existing_envelope'; job: PublicPdfSealJobSummary }
	| { outcome: 'idempotency_conflict' | 'not_found' | 'source_unavailable' };

export type PublicPdfSealStoreStatus =
	| { status: 'not_found' }
	| { status: 'not_requested'; sourceAvailable: boolean }
	| { status: 'pending' | 'processing'; job: PublicPdfSealJobSummary; attempts: number }
	| {
			status: 'failed';
			job: PublicPdfSealJobSummary;
			attempts: number;
			retryable: boolean;
			lastErrorCode: string;
	  }
	| {
			status: 'published';
			job: PublicPdfSealJobSummary;
			achievedProfile: PdfSealProfile;
			signerCertificateSha256: string;
			sealedSha256: string;
			sealedByteSize: number;
			validationReportSha256: string;
			validatedAt: string;
			publishedAt: string;
	  };

export interface PdfSealRequestStore {
	request(command: RequestPdfSealCommand): Promise<RequestPdfSealResult>;
	findStatus(envelopeId: string): Promise<PublicPdfSealStoreStatus>;
}

const ACTOR_ID_PATTERN: RegExp = /^[\x20-\x7e]{1,200}$/;
const IDEMPOTENCY_KEY_PATTERN: RegExp = /^[!-~]{1,200}$/;
const SHA256_PATTERN: RegExp = /^[0-9a-f]{64}$/;
const POLICY_ID_PATTERN: RegExp = /^[!-~]{1,128}$/;
const PUBLIC_ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
const ISO_TIMESTAMP_PATTERN: RegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function assertValidRequestPdfSealCommand(command: RequestPdfSealCommand): void {
	if (command.actor.type !== 'user' && command.actor.type !== 'agent') {
		throw new TypeError('actor.type must be user or agent');
	}
	if (!ACTOR_ID_PATTERN.test(command.actor.id) || command.actor.id !== command.actor.id.trim()) {
		throw new TypeError('actor.id is outside the supported bounds');
	}
	if (!IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey)) {
		throw new TypeError('idempotencyKey is outside the supported bounds');
	}
	if (!SHA256_PATTERN.test(command.requestHash)) {
		throw new TypeError('requestHash must be a lowercase SHA-256 digest');
	}
	for (const [name, value] of [
		['envelopeId', command.envelopeId],
		['jobId', command.jobId],
		['operationId', command.operationId],
		['validationId', command.validationId]
	] as const) {
		if (!UUID_V7_PATTERN.test(value)) throw new TypeError(`${name} must be a UUIDv7`);
	}
	if (!SHA256_PATTERN.test(command.signerCertificateSha256)) {
		throw new TypeError('signerCertificateSha256 must be a lowercase SHA-256 digest');
	}
	assertPolicy(command.sealPolicyId, 'sealPolicyId');
	assertPolicy(command.validationPolicyId, 'validationPolicyId');
	if (command.requestedProfile === 'pades-b-b') {
		if (command.tsaPolicyId !== null || command.tsaTrustBundleSha256 !== null) {
			throw new TypeError('pades-b-b must not include a TSA policy tuple');
		}
	} else if (command.requestedProfile === 'pades-b-t') {
		if (command.tsaPolicyId === null || command.tsaTrustBundleSha256 === null) {
			throw new TypeError('pades-b-t requires a complete TSA policy tuple');
		}
		assertPolicy(command.tsaPolicyId, 'tsaPolicyId');
		if (!SHA256_PATTERN.test(command.tsaTrustBundleSha256)) {
			throw new TypeError('tsaTrustBundleSha256 must be a lowercase SHA-256 digest');
		}
	} else {
		throw new TypeError('requestedProfile is unsupported');
	}
	if (
		!ISO_TIMESTAMP_PATTERN.test(command.requestedAt) ||
		new Date(command.requestedAt).toISOString() !== command.requestedAt
	) {
		throw new TypeError('requestedAt must be a canonical UTC timestamp');
	}
}

export function sanitizePublicPdfSealErrorCode(value: string | null): string {
	return value !== null && PUBLIC_ERROR_CODE_PATTERN.test(value) ? value : 'pdf_seal_failed';
}

function assertPolicy(value: string, name: string): void {
	if (!POLICY_ID_PATTERN.test(value))
		throw new TypeError(`${name} is outside the supported bounds`);
}
