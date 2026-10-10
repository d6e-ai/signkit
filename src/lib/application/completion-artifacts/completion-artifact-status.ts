import {
	EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR,
	sanitizeCompletionArtifactErrorCode,
	type CompletionArtifactStatusRow,
	type CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import {
	EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR,
	type CompletionArtifactPdfRepairStatusRow,
	type CompletionArtifactPdfRepairStore
} from '$lib/ports/completion-artifact-pdf-repair-store';

/**
 * A coarse, key-free signal of PDF availability:
 * - `published`: the PDF has a published record for this envelope.
 * - `pending`: the manifest is published but no PDF record exists yet; the
 *   PDF repair queue has not finished it (including a scheduled retry).
 * - `failed`: PDF repair stopped for good: a permanent evidence/budget
 *   failure, or exhausted transients that an operator may requeue
 *   (`retryEligible`).
 * - `unavailable`: this deployment has no PDF store configured.
 */
export type PublicCompletionPdfStatus = 'published' | 'pending' | 'unavailable' | 'failed';

export interface PublicCompletionPdfRepairStatus {
	status: 'pending' | 'processing' | 'failed';
	attempts: number;
	availableAt: string | null;
	/** Failure generation for a terminal failure; echo it back on retry. */
	failedAt: string | null;
}

export type PublicCompletionArtifactStatus =
	| { envelopeId: string; status: 'not_completed' }
	| {
			envelopeId: string;
			status: 'pending' | 'processing';
			attempts: number;
			availableAt: string | null;
	  }
	| {
			envelopeId: string;
			status: 'failed';
			attempts: number;
			errorCode: string | null;
			availableAt: string | null;
			/** Failure generation; echo it back on retry. */
			failedAt: string | null;
			retryEligible: boolean;
	  }
	| {
			envelopeId: string;
			status: 'published';
			publishedAt: string;
			manifestSha256: string;
			jsonSha256: string;
			markdownSha256: string;
			pdfStatus: PublicCompletionPdfStatus;
			pdfRepair: PublicCompletionPdfRepairStatus | null;
			retryEligible: boolean;
	  };

/** Backs the instance-authorized completion-artifact status endpoint. */
export class CompletionArtifactStatusService {
	readonly #store: CompletionArtifactStore;
	readonly #pdfStore: CompletionArtifactPdfStore | null;
	readonly #pdfRepairStore: CompletionArtifactPdfRepairStore | null;

	constructor(
		store: CompletionArtifactStore,
		pdfStore: CompletionArtifactPdfStore | null = null,
		pdfRepairStore: CompletionArtifactPdfRepairStore | null = null
	) {
		this.#store = store;
		this.#pdfStore = pdfStore;
		this.#pdfRepairStore = pdfRepairStore;
	}

	async find(envelopeId: string): Promise<PublicCompletionArtifactStatus | null> {
		const row: CompletionArtifactStatusRow | null =
			await this.#store.findCompletionArtifactStatus(envelopeId);
		if (row === null) return null;
		if (row.published !== null) {
			const pdf: {
				pdfStatus: PublicCompletionPdfStatus;
				pdfRepair: PublicCompletionPdfRepairStatus | null;
				retryEligible: boolean;
			} = await this.#publishedPdf(row.envelopeId);
			return {
				envelopeId: row.envelopeId,
				status: 'published',
				publishedAt: row.published.publishedAt,
				manifestSha256: row.published.manifestSha256,
				jsonSha256: row.published.jsonSha256,
				markdownSha256: row.published.markdownSha256,
				pdfStatus: pdf.pdfStatus,
				pdfRepair: pdf.pdfRepair,
				retryEligible: pdf.retryEligible
			};
		}
		if (row.jobStatus === 'failed') {
			const errorCode: string | null =
				row.lastError === null ? null : sanitizeCompletionArtifactErrorCode(row.lastError);
			return {
				envelopeId: row.envelopeId,
				status: 'failed',
				attempts: row.attempts ?? 0,
				errorCode,
				availableAt: row.availableAt,
				failedAt: row.updatedAt,
				retryEligible:
					row.lastError === EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR && row.updatedAt !== null
			};
		}
		if (row.jobStatus === 'processing') {
			return {
				envelopeId: row.envelopeId,
				status: 'processing',
				attempts: row.attempts ?? 0,
				availableAt: row.availableAt
			};
		}
		if (row.jobStatus === 'pending') {
			return {
				envelopeId: row.envelopeId,
				status: 'pending',
				attempts: row.attempts ?? 0,
				availableAt: row.availableAt
			};
		}
		if (row.envelopeCompleted) {
			return {
				envelopeId: row.envelopeId,
				status: 'pending',
				attempts: 0,
				availableAt: null
			};
		}
		return { envelopeId: row.envelopeId, status: 'not_completed' };
	}

	async #publishedPdf(envelopeId: string): Promise<{
		pdfStatus: PublicCompletionPdfStatus;
		pdfRepair: PublicCompletionPdfRepairStatus | null;
		retryEligible: boolean;
	}> {
		if (this.#pdfStore === null) {
			return { pdfStatus: 'unavailable', pdfRepair: null, retryEligible: false };
		}
		const record = await this.#pdfStore.readCompletionArtifactPdf(envelopeId);
		if (record !== null) {
			return { pdfStatus: 'published', pdfRepair: null, retryEligible: false };
		}
		const repair: CompletionArtifactPdfRepairStatusRow | null =
			this.#pdfRepairStore === null
				? null
				: await this.#pdfRepairStore.findPdfRepairStatus(envelopeId);
		if (repair === null || repair.status === 'repaired') {
			return { pdfStatus: 'pending', pdfRepair: null, retryEligible: false };
		}
		// A retryable failure is a scheduled retry the same drain will claim, so
		// it reads as pending with its next attempt time, never as failed.
		if (repair.status === 'failed' && !repair.retryable) {
			return {
				pdfStatus: 'failed',
				pdfRepair: {
					status: 'failed',
					attempts: repair.attempts,
					availableAt: null,
					failedAt: repair.updatedAt
				},
				retryEligible: repair.lastError === EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR
			};
		}
		const publicRepair: PublicCompletionPdfRepairStatus = {
			status: repair.status === 'processing' ? 'processing' : 'pending',
			attempts: repair.attempts,
			availableAt: repair.availableAt,
			failedAt: null
		};
		return { pdfStatus: 'pending', pdfRepair: publicRepair, retryEligible: false };
	}
}
