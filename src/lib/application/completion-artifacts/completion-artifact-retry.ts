import type {
	CompletionArtifactStatusRow,
	CompletionArtifactStore,
	RequeueExhaustedCompletionArtifactResult
} from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRepairStore,
	RequeueExhaustedCompletionArtifactPdfRepairResult
} from '$lib/ports/completion-artifact-pdf-repair-store';

export type CompletionArtifactRetryTarget = 'artifact' | 'pdf_repair';

export type CompletionArtifactRetryResult =
	| { outcome: 'requeued'; target: CompletionArtifactRetryTarget }
	| { outcome: 'replayed'; target: CompletionArtifactRetryTarget }
	| { outcome: 'conflict' }
	| { outcome: 'not_eligible' }
	| { outcome: 'not_found' };

export interface RetryExhaustedCompletionArtifactCommand {
	envelopeId: string;
	idempotencyKey: string;
	expectedAttempts: number;
	/** The exact failure generation the caller observed in the status read. */
	expectedFailedAt: string;
}

/**
 * Operator requeue for exhausted transient completion work. Never re-signs,
 * never overwrites a published artifact, and never appends audit past the
 * fixed completion publication anchor.
 *
 * The status row only selects the target queue: an unpublished envelope
 * targets the primary artifact job, a published one targets its PDF repair.
 * Eligibility (exact exhaustion code, no lease, attempts plus failure
 * generation) and idempotent replay are decided by the store's durable CAS,
 * never by this pre-read, so a duplicate or stale command racing a newer
 * failure cannot reset it.
 */
export class CompletionArtifactRetryService {
	readonly #store: CompletionArtifactStore;
	readonly #pdfRepairStore: CompletionArtifactPdfRepairStore | null;
	readonly #now: () => Date;

	constructor(
		store: CompletionArtifactStore,
		pdfRepairStore: CompletionArtifactPdfRepairStore | null = null,
		now: () => Date = (): Date => new Date()
	) {
		this.#store = store;
		this.#pdfRepairStore = pdfRepairStore;
		this.#now = now;
	}

	async retry(
		command: RetryExhaustedCompletionArtifactCommand
	): Promise<CompletionArtifactRetryResult> {
		// Publication may have finished before an ambiguous POST is retried.
		// Its original receipt must still replay, not switch to PDF repair or
		// reuse the same key for a different queue/generation.
		const replay = await this.#store.findCompletionArtifactRetry({
			...command,
			requeuedAt: this.#now().toISOString()
		});
		if (replay !== null) return mapStoreResult(replay, 'artifact');
		const row: CompletionArtifactStatusRow | null = await this.#store.findCompletionArtifactStatus(
			command.envelopeId
		);
		if (row === null) return { outcome: 'not_found' };

		if (row.published === null) {
			if (row.jobStatus === null) return { outcome: 'not_eligible' };
			const result: RequeueExhaustedCompletionArtifactResult =
				await this.#store.requeueExhaustedCompletionArtifact({
					envelopeId: command.envelopeId,
					idempotencyKey: command.idempotencyKey,
					expectedAttempts: command.expectedAttempts,
					expectedFailedAt: command.expectedFailedAt,
					requeuedAt: this.#now().toISOString()
				});
			return mapStoreResult(result, 'artifact');
		}

		if (this.#pdfRepairStore === null) return { outcome: 'not_eligible' };
		const result: RequeueExhaustedCompletionArtifactPdfRepairResult =
			await this.#pdfRepairStore.requeueExhaustedPdfRepair({
				envelopeId: command.envelopeId,
				idempotencyKey: command.idempotencyKey,
				expectedAttempts: command.expectedAttempts,
				expectedFailedAt: command.expectedFailedAt,
				requeuedAt: this.#now().toISOString()
			});
		return mapStoreResult(result, 'pdf_repair');
	}
}

function mapStoreResult(
	result:
		RequeueExhaustedCompletionArtifactResult | RequeueExhaustedCompletionArtifactPdfRepairResult,
	target: CompletionArtifactRetryTarget
): CompletionArtifactRetryResult {
	if (result.outcome === 'requeued' || result.outcome === 'replayed') {
		console.info(
			JSON.stringify({
				event:
					result.outcome === 'requeued'
						? 'completion_artifact_requeued'
						: 'completion_artifact_requeue_replayed',
				target
			})
		);
		return { outcome: result.outcome, target };
	}
	return { outcome: result.outcome };
}
