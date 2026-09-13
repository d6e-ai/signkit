import { describe, expect, it } from 'vitest';
import type {
	ClaimedInvitationDelivery,
	CompleteInvitationDeliveryResult,
	DeliveryOutboxStore,
	FailInvitationDeliveryResult,
	FindStaleSealedCapabilitiesCommand,
	ResealCapabilityCommand,
	ResealCapabilityResult,
	StaleSealedCapabilityRow
} from '$lib/ports/delivery-outbox-store';
import { AesGcmRecipientCapabilitySealer } from '$lib/security/delivery-capability';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { DeliveryResealSweepService } from './reseal-sweep-service';

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

const activeKey: string = key(1);
const previousKey: string = key(100);

class FakeStore implements DeliveryOutboxStore {
	rows: StaleSealedCapabilityRow[] = [];
	readonly resealCalls: ResealCapabilityCommand[] = [];
	resealOutcome: ResealCapabilityResult = { outcome: 'resealed' };

	async claimPendingInvitations(): Promise<readonly ClaimedInvitationDelivery[]> {
		return [];
	}
	async readClaimedInvitation(): Promise<ClaimedInvitationDelivery | null> {
		return null;
	}
	async completeInvitationDelivery(): Promise<CompleteInvitationDeliveryResult> {
		return { outcome: 'completed' };
	}
	async failInvitationDelivery(): Promise<FailInvitationDeliveryResult> {
		return { outcome: 'failed' };
	}
	async findStaleSealedCapabilities(
		command: FindStaleSealedCapabilitiesCommand
	): Promise<readonly StaleSealedCapabilityRow[]> {
		return this.rows.slice(0, command.limit);
	}
	async resealCapability(command: ResealCapabilityCommand): Promise<ResealCapabilityResult> {
		this.resealCalls.push(command);
		return this.resealOutcome;
	}
}

describe('DeliveryResealSweepService', () => {
	it('reseals stale ciphertext discovered by the store, leaving already-active rows untouched', async () => {
		const beforeRotation = new AesGcmRecipientCapabilitySealer(previousKey);
		const issued = await issueRecipientCapability();
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
				sealedCapability: sealed.sealedCapability,
				sealingKeyId: sealed.sealingKeyId
			}
		];

		const afterRotation = new AesGcmRecipientCapabilitySealer(activeKey, previousKey);
		const service = new DeliveryResealSweepService(store, afterRotation);
		const result = await service.resealOutstandingCapabilities();

		expect(result).toEqual({ discovered: 1, resealed: 1, stale: 0, unrecoverable: 0 });
		expect(store.resealCalls).toHaveLength(1);
		expect(store.resealCalls[0]).toMatchObject({
			organizationId: context.organizationId,
			deliveryId: context.deliveryId,
			previousSealingKeyId: sealed.sealingKeyId
		});
		expect(store.resealCalls[0].sealingKeyId).toBe(await afterRotation.currentSealingKeyId());

		// The resealed ciphertext must open to the same plaintext capability.
		const reopened = await afterRotation.open(
			store.resealCalls[0].sealedCapability,
			context,
			store.resealCalls[0].sealingKeyId
		);
		expect(reopened).toBe(issued.token);
	});

	it('leaves a row untouched when its key is outside the active/previous window', async () => {
		const retiredSealer = new AesGcmRecipientCapabilitySealer(key(200));
		const issued = await issueRecipientCapability();
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
				sealedCapability: sealed.sealedCapability,
				sealingKeyId: sealed.sealingKeyId
			}
		];

		const currentSealer = new AesGcmRecipientCapabilitySealer(activeKey, previousKey);
		const service = new DeliveryResealSweepService(store, currentSealer);
		const result = await service.resealOutstandingCapabilities();

		expect(result).toEqual({ discovered: 1, resealed: 0, stale: 0, unrecoverable: 1 });
		expect(store.resealCalls).toHaveLength(0);
	});

	it('counts a lost race as stale without treating it as an error', async () => {
		const beforeRotation = new AesGcmRecipientCapabilitySealer(previousKey);
		const issued = await issueRecipientCapability();
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
				sealedCapability: sealed.sealedCapability,
				sealingKeyId: sealed.sealingKeyId
			}
		];
		store.resealOutcome = { outcome: 'stale' };

		const afterRotation = new AesGcmRecipientCapabilitySealer(activeKey, previousKey);
		const service = new DeliveryResealSweepService(store, afterRotation);
		const result = await service.resealOutstandingCapabilities();

		expect(result).toEqual({ discovered: 1, resealed: 0, stale: 1, unrecoverable: 0 });
	});

	it('returns zero counts when nothing is stale', async () => {
		const store = new FakeStore();
		const sealer = new AesGcmRecipientCapabilitySealer(activeKey);
		const service = new DeliveryResealSweepService(store, sealer);
		await expect(service.resealOutstandingCapabilities()).resolves.toEqual({
			discovered: 0,
			resealed: 0,
			stale: 0,
			unrecoverable: 0
		});
	});
});
