import {
	sanitizeCompletionArtifactErrorCode,
	type CompletionArtifactStatusRow,
	type CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';

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
	  };

/** Backs the instance-authorized completion-artifact status endpoint. */
export class CompletionArtifactStatusService {
	constructor(private readonly store: CompletionArtifactStore) {}

	async find(envelopeId: string): Promise<PublicCompletionArtifactStatus | null> {
		const row: CompletionArtifactStatusRow | null =
			await this.store.findCompletionArtifactStatus(envelopeId);
		if (row === null) return null;
		if (row.published !== null) {
			return {
				envelopeId: row.envelopeId,
				status: 'published',
				publishedAt: row.published.publishedAt,
				manifestSha256: row.published.manifestSha256,
				jsonSha256: row.published.jsonSha256,
				markdownSha256: row.published.markdownSha256
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
}
