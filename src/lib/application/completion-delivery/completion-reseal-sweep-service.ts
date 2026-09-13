import {
	boundCompletionDeliveryResealSweepLimit,
	MAX_COMPLETION_DELIVERY_RESEAL_SWEEP_BATCH,
	type CompletionDeliveryStore,
	type StaleSealedCompletionTokenRow
} from '$lib/ports/completion-delivery-store';
import type {
	CompletionTokenSealContext,
	SealedCompletionToken
} from '$lib/security/completion-token-sealer';

export interface CompletionTokenResealer {
	currentSealingKeyId(): Promise<string>;
	open(
		sealedToken: string,
		context: CompletionTokenSealContext,
		sealingKeyId: string
	): Promise<string>;
	reseal(token: string, context: CompletionTokenSealContext): Promise<SealedCompletionToken>;
}

export interface CompletionDeliveryResealSweepResult {
	discovered: number;
	resealed: number;
	stale: number;
	unrecoverable: number;
}

/**
 * Bounded maintenance sweep migrating outstanding (non-`processing`)
 * completion delivery outbox ciphertext off a retiring key onto the active
 * one, independent of whether those rows are ever claimed for delivery
 * again soon. Never runs on the hot delivery-claim path.
 */
export class CompletionDeliveryResealSweepService {
	readonly #store: CompletionDeliveryStore;
	readonly #cryptor: CompletionTokenResealer;
	readonly #now: () => Date;

	constructor(
		store: CompletionDeliveryStore,
		cryptor: CompletionTokenResealer,
		now: () => Date = (): Date => new Date()
	) {
		this.#store = store;
		this.#cryptor = cryptor;
		this.#now = now;
	}

	async resealOutstandingTokens(
		limit: number = MAX_COMPLETION_DELIVERY_RESEAL_SWEEP_BATCH
	): Promise<CompletionDeliveryResealSweepResult> {
		const activeSealingKeyId: string = await this.#cryptor.currentSealingKeyId();
		const rows: readonly StaleSealedCompletionTokenRow[] =
			await this.#store.findStaleSealedCompletionTokens({
				activeSealingKeyId,
				limit: boundCompletionDeliveryResealSweepLimit(limit)
			});

		let resealed: number = 0;
		let stale: number = 0;
		let unrecoverable: number = 0;
		for (const row of rows) {
			const context: CompletionTokenSealContext = {
				organizationId: row.organizationId,
				envelopeId: row.envelopeId,
				recipientId: row.recipientId,
				deliveryId: row.deliveryId
			};
			let token: string;
			try {
				token = await this.#cryptor.open(row.sealedToken, context, row.sealingKeyId);
			} catch {
				// The key that sealed this row is outside the active/previous
				// window (or the ciphertext is otherwise unrecoverable); the
				// row is left untouched for an operator to investigate rather
				// than destroying evidence by resealing garbage.
				unrecoverable += 1;
				continue;
			}
			const sealed: SealedCompletionToken = await this.#cryptor.reseal(token, context);
			const result = await this.#store.resealCompletionToken({
				organizationId: row.organizationId,
				deliveryId: row.deliveryId,
				previousSealingKeyId: row.sealingKeyId,
				sealedToken: sealed.sealedToken,
				sealingKeyId: sealed.sealingKeyId,
				sealedTokenSha256: sealed.sealedTokenSha256,
				updatedAt: this.#now().toISOString()
			});
			if (result.outcome === 'resealed') resealed += 1;
			else stale += 1;
		}

		return { discovered: rows.length, resealed, stale, unrecoverable };
	}
}
