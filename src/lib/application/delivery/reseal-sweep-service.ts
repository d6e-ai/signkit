import {
	boundDeliveryResealSweepLimit,
	MAX_DELIVERY_RESEAL_SWEEP_BATCH,
	type DeliveryOutboxStore,
	type StaleSealedCapabilityRow
} from '$lib/ports/delivery-outbox-store';
import type {
	CapabilitySealContext,
	SealedRecipientCapability
} from '$lib/security/delivery-capability';

export interface DeliveryCapabilityResealer {
	currentSealingKeyId(): Promise<string>;
	open(
		sealedCapability: string,
		context: CapabilitySealContext,
		sealingKeyId: string
	): Promise<string>;
	reseal(token: string, context: CapabilitySealContext): Promise<SealedRecipientCapability>;
}

export interface DeliveryResealSweepResult {
	discovered: number;
	resealed: number;
	stale: number;
	unrecoverable: number;
}

/**
 * Bounded maintenance sweep migrating outstanding (non-`processing`) delivery
 * outbox ciphertext off a retiring key onto the active one, independent of
 * whether those rows are ever claimed for delivery again soon. Never runs on
 * the hot delivery-claim path.
 */
export class DeliveryResealSweepService {
	readonly #store: DeliveryOutboxStore;
	readonly #cryptor: DeliveryCapabilityResealer;
	readonly #now: () => Date;

	constructor(
		store: DeliveryOutboxStore,
		cryptor: DeliveryCapabilityResealer,
		now: () => Date = (): Date => new Date()
	) {
		this.#store = store;
		this.#cryptor = cryptor;
		this.#now = now;
	}

	async resealOutstandingCapabilities(
		limit: number = MAX_DELIVERY_RESEAL_SWEEP_BATCH
	): Promise<DeliveryResealSweepResult> {
		const activeSealingKeyId: string = await this.#cryptor.currentSealingKeyId();
		const rows: readonly StaleSealedCapabilityRow[] = await this.#store.findStaleSealedCapabilities(
			{ activeSealingKeyId, limit: boundDeliveryResealSweepLimit(limit) }
		);

		let resealed: number = 0;
		let stale: number = 0;
		let unrecoverable: number = 0;
		for (const row of rows) {
			const context: CapabilitySealContext = {
				envelopeId: row.envelopeId,
				recipientId: row.recipientId,
				deliveryId: row.deliveryId
			};
			let token: string;
			try {
				token = await this.#cryptor.open(row.sealedCapability, context, row.sealingKeyId);
			} catch {
				// The key that sealed this row is outside the active/previous
				// window (or the ciphertext is otherwise unrecoverable); the
				// row is left untouched for an operator to investigate rather
				// than destroying evidence by resealing garbage.
				unrecoverable += 1;
				continue;
			}
			const sealed: SealedRecipientCapability = await this.#cryptor.reseal(token, context);
			const result = await this.#store.resealCapability({
				deliveryId: row.deliveryId,
				previousSealingKeyId: row.sealingKeyId,
				sealedCapability: sealed.sealedCapability,
				sealingKeyId: sealed.sealingKeyId,
				sealedCapabilitySha256: sealed.sealedCapabilitySha256,
				updatedAt: this.#now().toISOString()
			});
			if (result.outcome === 'resealed') resealed += 1;
			else stale += 1;
		}

		return { discovered: rows.length, resealed, stale, unrecoverable };
	}
}
