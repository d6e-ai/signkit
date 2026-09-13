import { describe, expect, it } from 'vitest';
import type {
	ClaimedCompletionDelivery,
	CompleteCompletionDeliveryResult,
	CompletionArtifactLocator,
	CompletionDeliveryStore,
	EligibleCompletionDeliveryRecipient,
	FailCompletionDeliveryResult,
	FindStaleSealedCompletionTokensCommand,
	ResealCompletionTokenCommand,
	ResealCompletionTokenResult,
	StaleSealedCompletionTokenRow
} from '$lib/ports/completion-delivery-store';
import { AesGcmCompletionTokenSealer } from '$lib/security/completion-token-sealer';
import { issueCompletionToken } from '$lib/security/completion-token';
import { CompletionDeliveryResealSweepService } from './completion-reseal-sweep-service';

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

const activeKey: string = key(1);
const previousKey: string = key(100);

class FakeStore implements CompletionDeliveryStore {
	rows: StaleSealedCompletionTokenRow[] = [];
	readonly resealCalls: ResealCompletionTokenCommand[] = [];
	resealOutcome: ResealCompletionTokenResult = { outcome: 'resealed' };

	async discoverEligibleRecipients(): Promise<readonly EligibleCompletionDeliveryRecipient[]> {
		return [];
	}
	async enrollDeliveries(): Promise<number> {
		return 0;
	}
	async claimPendingDeliveries(): Promise<readonly ClaimedCompletionDelivery[]> {
		return [];
	}
	async readClaimedDelivery(): Promise<ClaimedCompletionDelivery | null> {
		return null;
	}
	async completeDelivery(): Promise<CompleteCompletionDeliveryResult> {
		return { outcome: 'completed' };
	}
	async failDelivery(): Promise<FailCompletionDeliveryResult> {
		return { outcome: 'failed' };
	}
	async resolveArtifactLocatorByTokenHash(): Promise<CompletionArtifactLocator | null> {
		return null;
	}
	async findStaleSealedCompletionTokens(
		command: FindStaleSealedCompletionTokensCommand
	): Promise<readonly StaleSealedCompletionTokenRow[]> {
		return this.rows.slice(0, command.limit);
	}
	async resealCompletionToken(
		command: ResealCompletionTokenCommand
	): Promise<ResealCompletionTokenResult> {
		this.resealCalls.push(command);
		return this.resealOutcome;
	}
}

describe('CompletionDeliveryResealSweepService', () => {
	it('reseals stale ciphertext discovered by the store', async () => {
		const beforeRotation = new AesGcmCompletionTokenSealer(previousKey);
		const issued = await issueCompletionToken();
		const context = {
			organizationId: 'org-1',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			deliveryId: 'delivery-1'
		};
		const sealed = await beforeRotation.seal(issued.token, context);

		const store = new FakeStore();
		store.rows = [
			{
				deliveryId: context.deliveryId,
				organizationId: context.organizationId,
				envelopeId: context.envelopeId,
				recipientId: context.recipientId,
				sealedToken: sealed.sealedToken,
				sealingKeyId: sealed.sealingKeyId
			}
		];

		const afterRotation = new AesGcmCompletionTokenSealer(activeKey, previousKey);
		const service = new CompletionDeliveryResealSweepService(store, afterRotation);
		const result = await service.resealOutstandingTokens();

		expect(result).toEqual({ discovered: 1, resealed: 1, stale: 0, unrecoverable: 0 });
		expect(store.resealCalls).toHaveLength(1);
		expect(store.resealCalls[0].previousSealingKeyId).toBe(sealed.sealingKeyId);
		expect(store.resealCalls[0].sealingKeyId).toBe(await afterRotation.currentSealingKeyId());

		const reopened = await afterRotation.open(
			store.resealCalls[0].sealedToken,
			context,
			store.resealCalls[0].sealingKeyId
		);
		expect(reopened).toBe(issued.token);
	});

	it('leaves a row untouched when its key is outside the active/previous window', async () => {
		const retiredSealer = new AesGcmCompletionTokenSealer(key(200));
		const issued = await issueCompletionToken();
		const context = {
			organizationId: 'org-1',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			deliveryId: 'delivery-1'
		};
		const sealed = await retiredSealer.seal(issued.token, context);

		const store = new FakeStore();
		store.rows = [
			{
				deliveryId: context.deliveryId,
				organizationId: context.organizationId,
				envelopeId: context.envelopeId,
				recipientId: context.recipientId,
				sealedToken: sealed.sealedToken,
				sealingKeyId: sealed.sealingKeyId
			}
		];

		const currentSealer = new AesGcmCompletionTokenSealer(activeKey, previousKey);
		const service = new CompletionDeliveryResealSweepService(store, currentSealer);
		const result = await service.resealOutstandingTokens();

		expect(result).toEqual({ discovered: 1, resealed: 0, stale: 0, unrecoverable: 1 });
		expect(store.resealCalls).toHaveLength(0);
	});

	it('returns zero counts when nothing is stale', async () => {
		const store = new FakeStore();
		const sealer = new AesGcmCompletionTokenSealer(activeKey);
		const service = new CompletionDeliveryResealSweepService(store, sealer);
		await expect(service.resealOutstandingTokens()).resolves.toEqual({
			discovered: 0,
			resealed: 0,
			stale: 0,
			unrecoverable: 0
		});
	});
});
