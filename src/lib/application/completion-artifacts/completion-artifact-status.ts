import {
	sanitizeCompletionArtifactErrorCode,
	type CompletionArtifactStatusRow,
	type CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';

/**
 * A coarse, key-free signal of PDF availability:
 * - `published`: the PDF has a published record for this envelope.
 * - `pending`: the manifest is published but no PDF record exists yet — the
 *   deployment supports PDF generation and a later sweep may still produce
 *   one (PDF publication is a pure, safely-backfillable function of already
 *   published evidence).
 * - `unavailable`: this deployment has no PDF store configured, so a PDF
 *   will never be produced for this envelope.
 */
export type PublicCompletionPdfStatus = 'published' | 'pending' | 'unavailable';

export type PublicCompletionArtifactStatus =
	| { envelopeId: string; status: 'not_completed' }
	| { envelopeId: string; status: 'pending' | 'processing'; attempts: number }
	| {
			envelopeId: string;
			status: 'failed';
			attempts: number;
			errorCode: string | null;
			availableAt: string | null;
	  }
	| {
			envelopeId: string;
			status: 'published';
			publishedAt: string;
			manifestSha256: string;
			jsonSha256: string;
			markdownSha256: string;
			pdfStatus: PublicCompletionPdfStatus;
	  };

/** Backs the instance-authorized completion-artifact status endpoint. */
export class CompletionArtifactStatusService {
	readonly #store: CompletionArtifactStore;
	readonly #pdfStore: CompletionArtifactPdfStore | null;

	constructor(store: CompletionArtifactStore, pdfStore: CompletionArtifactPdfStore | null = null) {
		this.#store = store;
		this.#pdfStore = pdfStore;
	}

	async find(envelopeId: string): Promise<PublicCompletionArtifactStatus | null> {
		const row: CompletionArtifactStatusRow | null =
			await this.#store.findCompletionArtifactStatus(envelopeId);
		if (row === null) return null;
		if (row.published !== null) {
			return {
				envelopeId: row.envelopeId,
				status: 'published',
				publishedAt: row.published.publishedAt,
				manifestSha256: row.published.manifestSha256,
				jsonSha256: row.published.jsonSha256,
				markdownSha256: row.published.markdownSha256,
				pdfStatus: await this.#pdfStatus(row.envelopeId)
			};
		}
		if (row.jobStatus === 'failed') {
			return {
				envelopeId: row.envelopeId,
				status: 'failed',
				attempts: row.attempts ?? 0,
				errorCode:
					row.lastError === null ? null : sanitizeCompletionArtifactErrorCode(row.lastError),
				availableAt: row.availableAt
			};
		}
		if (row.jobStatus === 'processing') {
			return { envelopeId: row.envelopeId, status: 'processing', attempts: row.attempts ?? 0 };
		}
		if (row.jobStatus === 'pending') {
			return { envelopeId: row.envelopeId, status: 'pending', attempts: row.attempts ?? 0 };
		}
		if (row.envelopeCompleted) {
			return { envelopeId: row.envelopeId, status: 'pending', attempts: 0 };
		}
		return { envelopeId: row.envelopeId, status: 'not_completed' };
	}

	async #pdfStatus(envelopeId: string): Promise<PublicCompletionPdfStatus> {
		if (this.#pdfStore === null) return 'unavailable';
		const record = await this.#pdfStore.readCompletionArtifactPdf(envelopeId);
		return record === null ? 'pending' : 'published';
	}
}
