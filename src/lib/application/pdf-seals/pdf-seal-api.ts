import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import { sha256TextHex } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	PdfSealRequestStore,
	PublicPdfSealStoreStatus,
	RequestPdfSealResult
} from '$lib/ports/pdf-seal-request-store';
import type { PdfSealRequestPolicy } from './pdf-seal-runtime';
import type { PdfSealProfile } from '$lib/ports/pdf-seal-provider';

export interface RequestPdfSealInput {
	idempotencyKey: string;
	requestedProfile: PdfSealProfile;
	policy: PdfSealRequestPolicy;
}

export interface RequestedPdfSeal {
	envelopeId: string;
	jobId: string;
	requestedProfile: PdfSealProfile;
	requestedAt: string;
}

export type RequestPdfSealApplicationResult =
	| { outcome: 'requested' | 'replayed' | 'existing'; request: RequestedPdfSeal }
	| { outcome: 'idempotency_conflict' | 'not_found' | 'source_unavailable' };

export type PublicPdfSealStatus =
	| { envelopeId: string; status: 'disabled' | 'not_requested' }
	| {
			envelopeId: string;
			status: 'pending' | 'processing';
			requestedProfile: PdfSealProfile;
			attempts: number;
			requestedAt: string;
	  }
	| {
			envelopeId: string;
			status: 'failed';
			requestedProfile: PdfSealProfile;
			attempts: number;
			retryable: boolean;
			errorCode: string;
			requestedAt: string;
	  }
	| {
			envelopeId: string;
			status: 'published';
			requestedProfile: PdfSealProfile;
			achievedProfile: PdfSealProfile;
			signerCertificateSha256: string;
			sealedSha256: string;
			sealedByteSize: number;
			validationReportSha256: string;
			validatedAt: string;
			publishedAt: string;
	  };

export interface PdfSealApiApplicationPort {
	request(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: RequestPdfSealInput
	): Promise<RequestPdfSealApplicationResult>;
	findStatus(envelopeId: string, configured: boolean): Promise<PublicPdfSealStatus | null>;
}

/** Explicit-request boundary. It is the only product path allowed to create a seal job. */
export class PdfSealApiApplication implements PdfSealApiApplicationPort {
	readonly #store: PdfSealRequestStore;
	readonly #now: () => Date;
	readonly #newId: UuidV7Generator;

	constructor(
		store: PdfSealRequestStore,
		now: () => Date = (): Date => new Date(),
		newId: UuidV7Generator = newUuidV7
	) {
		this.#store = store;
		this.#now = now;
		this.#newId = newId;
	}

	async request(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: RequestPdfSealInput
	): Promise<RequestPdfSealApplicationResult> {
		const requestHash: string = await sha256TextHex(
			JSON.stringify({ envelopeId, requestedProfile: input.requestedProfile })
		);
		const result: RequestPdfSealResult = await this.#store.request({
			actor: { type: actor.actorType ?? 'user', id: actor.id },
			idempotencyKey: input.idempotencyKey,
			requestHash,
			envelopeId,
			jobId: this.#newId(),
			operationId: this.#newId(),
			validationId: this.#newId(),
			requestedProfile: input.requestedProfile,
			signerCertificateSha256: input.policy.signerCertificateSha256,
			sealPolicyId: input.policy.sealPolicyId,
			validationPolicyId: input.policy.validationPolicyId,
			tsaPolicyId: input.policy.tsaPolicyId,
			tsaTrustBundleSha256: input.policy.tsaTrustBundleSha256,
			requestedAt: this.#now().toISOString()
		});
		if (
			result.outcome === 'requested' ||
			result.outcome === 'replayed' ||
			result.outcome === 'existing_envelope'
		) {
			return {
				outcome: result.outcome === 'existing_envelope' ? 'existing' : result.outcome,
				request: result.job
			};
		}
		return result;
	}

	async findStatus(envelopeId: string, configured: boolean): Promise<PublicPdfSealStatus | null> {
		const status: PublicPdfSealStoreStatus = await this.#store.findStatus(envelopeId);
		switch (status.status) {
			case 'not_found':
				return null;
			case 'not_requested':
				return { envelopeId, status: configured ? 'not_requested' : 'disabled' };
			case 'pending':
			case 'processing':
				return {
					envelopeId,
					status: status.status,
					requestedProfile: status.job.requestedProfile,
					attempts: status.attempts,
					requestedAt: status.job.requestedAt
				};
			case 'failed':
				return {
					envelopeId,
					status: 'failed',
					requestedProfile: status.job.requestedProfile,
					attempts: status.attempts,
					retryable: status.retryable,
					errorCode: status.lastErrorCode,
					requestedAt: status.job.requestedAt
				};
			case 'published':
				return {
					envelopeId,
					status: 'published',
					requestedProfile: status.job.requestedProfile,
					achievedProfile: status.achievedProfile,
					signerCertificateSha256: status.signerCertificateSha256,
					sealedSha256: status.sealedSha256,
					sealedByteSize: status.sealedByteSize,
					validationReportSha256: status.validationReportSha256,
					validatedAt: status.validatedAt,
					publishedAt: status.publishedAt
				};
		}
	}
}
