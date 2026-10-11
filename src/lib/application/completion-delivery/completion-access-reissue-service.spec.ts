import { describe, expect, it, vi } from 'vitest';
import type { CompletionAccessReissueArtifactVerification } from './completion-access-reissue-artifact-verifier';
import { CompletionAccessReissueService } from './completion-access-reissue-service';
import type {
	CompletionAccessReissueActor,
	ReissueCompletionAccessInput
} from './completion-access-reissue-service';
import type {
	CompletionAccessReissuePreparationOutcome,
	CompletionAccessReissueStore,
	PublishCompletionAccessReissueCommand,
	PublishCompletionAccessReissueOutcome,
	ReissueCommandKey
} from '$lib/ports/completion-access-reissue';
import type {
	CompletionTokenSealContext,
	CompletionTokenSealer
} from '$lib/security/completion-token-sealer';

const NOW: Date = new Date('2026-09-13T12:00:00.000Z');

function baseInput(
	overrides: Partial<ReissueCompletionAccessInput> = {}
): ReissueCompletionAccessInput {
	return {
		envelopeId: 'envelope-1',
		recipientId: 'recipient-1',
		idempotencyKey: 'idemp-1',
		expectedDeliveryId: 'delivery-1',
		expectedAttempts: 10,
		expectedFailedAt: '2026-09-13T11:00:00.000Z',
		expectedErrorCode: 'completion_delivery_attempts_exhausted',
		...overrides
	};
}

function readyPreparation(): CompletionAccessReissuePreparationOutcome {
	return {
		outcome: 'ready',
		predecessorGeneration: 0,
		auditHead: { sequence: 1, eventHash: 'e'.repeat(64) }
	};
}

function fakeStore(
	overrides: Partial<CompletionAccessReissueStore> = {}
): CompletionAccessReissueStore {
	return {
		listCurrentDeliveries: vi.fn(async () => []),
		prepareReissue: vi.fn(async (): Promise<CompletionAccessReissuePreparationOutcome> =>
			readyPreparation()
		),
		publishReissue: vi.fn(
			async (
				command: PublishCompletionAccessReissueCommand
			): Promise<PublishCompletionAccessReissueOutcome> => ({
				outcome: 'published',
				result: {
					envelopeId: command.envelopeId,
					recipientId: command.recipientId,
					deliveryId: command.newDeliveryId,
					generation: 1,
					accessExpiresAt: command.newAccessExpiresAt,
					reissuedAt: command.reissuedAt,
					auditEventId: command.auditEventId
				}
			})
		),
		...overrides
	};
}

function fakeVerifier(
	outcome: CompletionAccessReissueArtifactVerification = {
		outcome: 'verified',
		pointer: {
			jsonSha256: 'j'.repeat(64),
			markdownSha256: 'd'.repeat(64),
			pdfSha256: 'a'.repeat(64)
		}
	}
): { verify: ReturnType<typeof vi.fn> } {
	return { verify: vi.fn(async () => outcome) };
}

function fakeSealer(): CompletionTokenSealer {
	return {
		currentSealingKeyId: vi.fn(async () => 'key-1'),
		seal: vi.fn(async (_token: string, context: CompletionTokenSealContext) => ({
			sealedToken: `skcd1_sealed-${context.deliveryId}`,
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64)
		}))
	};
}

const ACTOR: CompletionAccessReissueActor = { type: 'user', id: 'user-1' };

describe('CompletionAccessReissueService', () => {
	it('publishes a new generation after independently verifying the manifest and PDF', async () => {
		const store = fakeStore();
		const verifier = fakeVerifier();
		const service = new CompletionAccessReissueService(
			store,
			verifier as never,
			fakeSealer(),
			() => NOW,
			() => 'new-delivery-1'
		);
		const result = await service.reissue(ACTOR, baseInput());
		expect(result.outcome).toBe('published');
		expect(verifier.verify).toHaveBeenCalledWith('envelope-1');
		expect(store.publishReissue).toHaveBeenCalledOnce();
		const command = (store.publishReissue as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as PublishCompletionAccessReissueCommand;
		expect(command.expectedJsonSha256).toBe('j'.repeat(64));
		expect(command.expectedPdfSha256).toBe('a'.repeat(64));
		expect(command.newAccessExpiresAt).toBe('2026-10-13T12:00:00.000Z');
	});

	it('never verifies artifacts or mints a token for a request that is already ineligible', async () => {
		const store = fakeStore({
			prepareReissue: vi.fn(async (): Promise<CompletionAccessReissuePreparationOutcome> => ({
				outcome: 'not_eligible',
				notEligibleReason: 'predecessor_not_exhausted'
			}))
		});
		const verifier = fakeVerifier();
		const sealer = fakeSealer();
		const service = new CompletionAccessReissueService(store, verifier as never, sealer, () => NOW);
		const result = await service.reissue(ACTOR, baseInput());
		expect(result).toEqual({ outcome: 'not_eligible', reason: 'predecessor_not_exhausted' });
		expect(verifier.verify).not.toHaveBeenCalled();
		expect(sealer.seal).not.toHaveBeenCalled();
		expect(store.publishReissue).not.toHaveBeenCalled();
	});

	it('replays a safe duplicate without minting a new grant', async () => {
		const store = fakeStore({
			prepareReissue: vi.fn(async (): Promise<CompletionAccessReissuePreparationOutcome> => ({
				outcome: 'replayed',
				result: {
					envelopeId: 'envelope-1',
					recipientId: 'recipient-1',
					deliveryId: 'delivery-2',
					generation: 1,
					accessExpiresAt: '2026-10-13T12:00:00.000Z',
					reissuedAt: '2026-09-13T12:00:00.000Z',
					auditEventId: 'audit-1'
				}
			}))
		});
		const verifier = fakeVerifier();
		const service = new CompletionAccessReissueService(
			store,
			verifier as never,
			fakeSealer(),
			() => NOW
		);
		const result = await service.reissue(ACTOR, baseInput());
		expect(result).toEqual({
			outcome: 'replayed',
			result: {
				envelopeId: 'envelope-1',
				recipientId: 'recipient-1',
				deliveryId: 'delivery-2',
				generation: 1,
				accessExpiresAt: '2026-10-13T12:00:00.000Z',
				reissuedAt: '2026-09-13T12:00:00.000Z',
				auditEventId: 'audit-1'
			}
		});
		expect(verifier.verify).not.toHaveBeenCalled();
	});

	it('rejects when the completion artifact is not yet published', async () => {
		const store = fakeStore();
		const verifier = fakeVerifier({ outcome: 'unpublished' });
		const service = new CompletionAccessReissueService(
			store,
			verifier as never,
			fakeSealer(),
			() => NOW
		);
		const result = await service.reissue(ACTOR, baseInput());
		expect(result).toEqual({ outcome: 'artifact_unavailable' });
		expect(store.publishReissue).not.toHaveBeenCalled();
	});

	it('rejects after bounded retries when the PDF bytes are actually corrupt', async () => {
		const store = fakeStore();
		const verifier = fakeVerifier({
			outcome: 'integrity_error',
			errorCode: 'completion_pdf_digest_mismatch'
		});
		const service = new CompletionAccessReissueService(
			store,
			verifier as never,
			fakeSealer(),
			() => NOW
		);
		const result = await service.reissue(ACTOR, baseInput());
		expect(result).toEqual({ outcome: 'integrity_error' });
		expect(verifier.verify).toHaveBeenCalledOnce();
		expect(store.publishReissue).not.toHaveBeenCalled();
	});

	it('retries a transient object-storage error before failing closed', async () => {
		const store = fakeStore();
		const verifier = fakeVerifier({
			outcome: 'retryable_error',
			errorCode: 'completion_pdf_object_missing'
		});
		const service = new CompletionAccessReissueService(
			store,
			verifier as never,
			fakeSealer(),
			() => NOW
		);
		const result = await service.reissue(ACTOR, baseInput());
		expect(result).toEqual({ outcome: 'integrity_error' });
		expect(verifier.verify).toHaveBeenCalledTimes(3);
		expect(store.publishReissue).not.toHaveBeenCalled();
	});

	it('retries once when publication aborts on an audit-head race and then succeeds', async () => {
		const publishReissue = vi
			.fn()
			.mockResolvedValueOnce({ outcome: 'integrity_error' })
			.mockResolvedValueOnce({
				outcome: 'published',
				result: {
					envelopeId: 'envelope-1',
					recipientId: 'recipient-1',
					deliveryId: 'new-delivery-1',
					generation: 1,
					accessExpiresAt: '2026-10-13T12:00:00.000Z',
					reissuedAt: '2026-09-13T12:00:00.000Z',
					auditEventId: 'audit-1'
				}
			});
		const store = fakeStore({ publishReissue });
		const verifier = fakeVerifier();
		const service = new CompletionAccessReissueService(
			store,
			verifier as never,
			fakeSealer(),
			() => NOW,
			() => 'new-delivery-1'
		);
		const result = await service.reissue(ACTOR, baseInput());
		expect(result.outcome).toBe('published');
		expect(publishReissue).toHaveBeenCalledTimes(2);
		expect(store.prepareReissue).toHaveBeenCalledTimes(2);
	});

	it('computes the request hash from the full expected-generation tuple so a changed body is never replayed', async () => {
		const store = fakeStore();
		const verifier = fakeVerifier();
		const service = new CompletionAccessReissueService(
			store,
			verifier as never,
			fakeSealer(),
			() => NOW
		);
		await service.reissue(ACTOR, baseInput({ expectedAttempts: 10 }));
		const firstHash = (
			(store.prepareReissue as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReissueCommandKey
		).requestHash;
		await service.reissue(ACTOR, baseInput({ expectedAttempts: 11 }));
		const secondHash = (
			(store.prepareReissue as ReturnType<typeof vi.fn>).mock.calls[1][0] as ReissueCommandKey
		).requestHash;
		expect(firstHash).not.toBe(secondHash);
	});
});
