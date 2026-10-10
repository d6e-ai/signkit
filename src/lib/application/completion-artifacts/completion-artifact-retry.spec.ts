import { describe, expect, it, vi } from 'vitest';
import {
	EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR,
	type CompletionArtifactStatusRow,
	type CompletionArtifactStore,
	type RequeueExhaustedCompletionArtifactCommand,
	type RequeueExhaustedCompletionArtifactResult
} from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRepairStore,
	RequeueExhaustedCompletionArtifactPdfRepairCommand,
	RequeueExhaustedCompletionArtifactPdfRepairResult
} from '$lib/ports/completion-artifact-pdf-repair-store';
import { CompletionArtifactRetryService } from './completion-artifact-retry';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const NOW: Date = new Date('2026-09-12T00:00:00.000Z');
const FAILED_AT: string = '2026-09-11T23:00:00.000Z';

function artifactStore(
	row: CompletionArtifactStatusRow | null,
	requeue: RequeueExhaustedCompletionArtifactResult = { outcome: 'requeued' }
): CompletionArtifactStore & {
	requeueCalls: RequeueExhaustedCompletionArtifactCommand[];
} {
	const requeueCalls: RequeueExhaustedCompletionArtifactCommand[] = [];
	return {
		claimPendingCompletionArtifacts: vi.fn(),
		readClaimedCompletionArtifact: vi.fn(),
		readCompletionEvidence: vi.fn(),
		publishCompletionArtifact: vi.fn(),
		failCompletionArtifact: vi.fn(),
		findCompletionArtifactRetry: async () => null,
		requeueCalls,
		async requeueExhaustedCompletionArtifact(
			command: RequeueExhaustedCompletionArtifactCommand
		): Promise<RequeueExhaustedCompletionArtifactResult> {
			requeueCalls.push(command);
			return requeue;
		},
		findCompletionArtifactStatus: async () => row
	} as CompletionArtifactStore & {
		requeueCalls: RequeueExhaustedCompletionArtifactCommand[];
	};
}

function repairStore(
	requeue: RequeueExhaustedCompletionArtifactPdfRepairResult = { outcome: 'requeued' }
): CompletionArtifactPdfRepairStore & {
	requeueCalls: RequeueExhaustedCompletionArtifactPdfRepairCommand[];
} {
	const requeueCalls: RequeueExhaustedCompletionArtifactPdfRepairCommand[] = [];
	return {
		claimPendingPdfRepairs: vi.fn(),
		readClaimedPdfRepair: vi.fn(),
		completePdfRepair: vi.fn(),
		failPdfRepair: vi.fn(),
		requeueCalls,
		async requeueExhaustedPdfRepair(
			command: RequeueExhaustedCompletionArtifactPdfRepairCommand
		): Promise<RequeueExhaustedCompletionArtifactPdfRepairResult> {
			requeueCalls.push(command);
			return requeue;
		},
		findPdfRepairStatus: vi.fn()
	} as CompletionArtifactPdfRepairStore & {
		requeueCalls: RequeueExhaustedCompletionArtifactPdfRepairCommand[];
	};
}

function failedRow(
	overrides: Partial<CompletionArtifactStatusRow> = {}
): CompletionArtifactStatusRow {
	return {
		envelopeId: ENVELOPE_ID,
		envelopeCompleted: true,
		jobStatus: 'failed',
		attempts: 10,
		lastError: EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR,
		availableAt: FAILED_AT,
		updatedAt: FAILED_AT,
		published: null,
		...overrides
	};
}

const PUBLISHED: CompletionArtifactStatusRow['published'] = {
	envelopeId: ENVELOPE_ID,
	manifestSha256: 'm'.repeat(64),
	jsonSha256: 'j'.repeat(64),
	markdownSha256: 'd'.repeat(64),
	publishedAt: NOW.toISOString(),
	auditEventId: 'audit-1'
};

describe('CompletionArtifactRetryService', () => {
	it.each(['replayed', 'conflict'] as const)(
		'uses the original artifact receipt after publication: %s',
		async (outcome) => {
			const store = artifactStore(failedRow({ jobStatus: 'published', published: PUBLISHED }));
			store.findCompletionArtifactRetry = async () => ({ outcome });
			const repair = repairStore();
			await expect(
				new CompletionArtifactRetryService(store, repair, () => NOW).retry({
					envelopeId: ENVELOPE_ID,
					idempotencyKey: 'retry-1',
					expectedAttempts: 10,
					expectedFailedAt: FAILED_AT
				})
			).resolves.toEqual(outcome === 'replayed' ? { outcome, target: 'artifact' } : { outcome });
			expect(store.requeueCalls).toHaveLength(0);
			expect(repair.requeueCalls).toHaveLength(0);
		}
	);
	it('forwards the observed attempts and failure generation to the artifact CAS', async () => {
		const store = artifactStore(failedRow());
		const service = new CompletionArtifactRetryService(store, null, () => NOW);
		await expect(
			service.retry({
				envelopeId: ENVELOPE_ID,
				idempotencyKey: 'retry-1',
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT
			})
		).resolves.toEqual({ outcome: 'requeued', target: 'artifact' });
		expect(store.requeueCalls).toEqual([
			{
				envelopeId: ENVELOPE_ID,
				idempotencyKey: 'retry-1',
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT,
				requeuedAt: NOW.toISOString()
			}
		]);
	});

	it('lets the durable receipt replay a key whose job was already requeued', async () => {
		// After a successful requeue the status row is no longer failed; a
		// service-side pre-check would wrongly refuse the duplicate key here.
		const store = artifactStore(failedRow({ jobStatus: 'pending', lastError: null, attempts: 0 }), {
			outcome: 'replayed'
		});
		const service = new CompletionArtifactRetryService(store, null, () => NOW);
		await expect(
			service.retry({
				envelopeId: ENVELOPE_ID,
				idempotencyKey: 'retry-1',
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT
			})
		).resolves.toEqual({ outcome: 'replayed', target: 'artifact' });
	});

	it('surfaces the store CAS refusal and idempotency conflict without a target', async () => {
		for (const outcome of ['not_eligible', 'conflict'] as const) {
			const store = artifactStore(failedRow(), { outcome });
			await expect(
				new CompletionArtifactRetryService(store, null, () => NOW).retry({
					envelopeId: ENVELOPE_ID,
					idempotencyKey: 'retry-1',
					expectedAttempts: 10,
					expectedFailedAt: FAILED_AT
				})
			).resolves.toEqual({ outcome });
		}
	});

	it('refuses a completed envelope whose job was never discovered', async () => {
		const store = artifactStore(failedRow({ jobStatus: null, attempts: null, lastError: null }));
		await expect(
			new CompletionArtifactRetryService(store, null, () => NOW).retry({
				envelopeId: ENVELOPE_ID,
				idempotencyKey: 'retry-1',
				expectedAttempts: 0,
				expectedFailedAt: FAILED_AT
			})
		).resolves.toEqual({ outcome: 'not_eligible' });
		expect(store.requeueCalls).toHaveLength(0);
	});

	it('targets PDF repair, never the primary job, once the artifact is published', async () => {
		const store = artifactStore(
			failedRow({ jobStatus: 'published', lastError: null, published: PUBLISHED })
		);
		const repair = repairStore();
		const service = new CompletionArtifactRetryService(store, repair, () => NOW);
		await expect(
			service.retry({
				envelopeId: ENVELOPE_ID,
				idempotencyKey: 'retry-pdf',
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT
			})
		).resolves.toEqual({ outcome: 'requeued', target: 'pdf_repair' });
		expect(store.requeueCalls).toHaveLength(0);
		expect(repair.requeueCalls[0]).toMatchObject({
			idempotencyKey: 'retry-pdf',
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT
		});
	});

	it('refuses PDF repair retry when no repair store is wired', async () => {
		const store = artifactStore(
			failedRow({ jobStatus: 'published', lastError: null, published: PUBLISHED })
		);
		await expect(
			new CompletionArtifactRetryService(store, null, () => NOW).retry({
				envelopeId: ENVELOPE_ID,
				idempotencyKey: 'retry-pdf',
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT
			})
		).resolves.toEqual({ outcome: 'not_eligible' });
	});

	it('returns not_found when the envelope does not exist', async () => {
		const store = artifactStore(null);
		await expect(
			new CompletionArtifactRetryService(store, null, () => NOW).retry({
				envelopeId: ENVELOPE_ID,
				idempotencyKey: 'retry-1',
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT
			})
		).resolves.toEqual({ outcome: 'not_found' });
	});
});
