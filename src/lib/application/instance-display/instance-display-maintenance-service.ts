import {
	INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT,
	INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT,
	boundInstanceDisplayCleanupLimit,
	boundInstanceDisplayResealLimit
} from '$lib/domain/instance-display';
import type {
	InstanceDisplayStore,
	InstanceInvitationDisplayRow,
	InstanceMemberDisplayRow
} from '$lib/ports/instance-display-store';
import type { InstanceDisplayPayloadSealer } from '$lib/security/instance-display-payload';

export interface InstanceDisplayMaintenanceResult {
	expired: number;
	deleted: number;
	discovered: number;
	resealed: number;
	stale: number;
	unrecoverable: number;
}

export class InstanceDisplayMaintenanceService {
	readonly #store: InstanceDisplayStore;
	readonly #sealer: InstanceDisplayPayloadSealer | null;
	readonly #now: () => Date;

	constructor(
		store: InstanceDisplayStore,
		sealer: InstanceDisplayPayloadSealer | null,
		now: () => Date = (): Date => new Date()
	) {
		this.#store = store;
		this.#sealer = sealer;
		this.#now = now;
	}

	async maintain(
		cleanupLimit: number = INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT,
		resealLimit: number = INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT
	): Promise<InstanceDisplayMaintenanceResult> {
		const now: string = this.#now().toISOString();
		const cleaned = await this.#store.cleanupExpired(
			now,
			boundInstanceDisplayCleanupLimit(cleanupLimit)
		);
		if (this.#sealer === null) {
			return {
				expired: cleaned.expired,
				deleted: cleaned.deleted,
				discovered: 0,
				resealed: 0,
				stale: 0,
				unrecoverable: 0
			};
		}

		const bound: number = boundInstanceDisplayResealLimit(resealLimit);
		const memberPreviousKeyId: string | null = await this.#sealer.memberPreviousKeyId();
		const invitationPreviousKeyId: string | null = await this.#sealer.invitationPreviousKeyId();
		const memberBudget: number = Math.floor(bound / 2);
		const members: readonly InstanceMemberDisplayRow[] =
			memberPreviousKeyId === null || memberBudget < 1
				? []
				: await this.#store.findMemberRowsForReseal(memberPreviousKeyId, now, memberBudget);
		const invitationBudget: number = bound - members.length;
		const invitations: readonly InstanceInvitationDisplayRow[] =
			invitationPreviousKeyId === null || invitationBudget < 1
				? []
				: await this.#store.findInvitationRowsForReseal(
						invitationPreviousKeyId,
						now,
						invitationBudget
					);

		let resealed: number = 0;
		let stale: number = 0;
		let unrecoverable: number = 0;

		for (const row of members) {
			const outcome = await this.#resealMember(row, now);
			if (outcome === 'resealed') resealed += 1;
			else if (outcome === 'stale') stale += 1;
			else unrecoverable += 1;
		}
		for (const row of invitations) {
			const outcome = await this.#resealInvitation(row, now);
			if (outcome === 'resealed') resealed += 1;
			else if (outcome === 'stale') stale += 1;
			else unrecoverable += 1;
		}

		return {
			expired: cleaned.expired,
			deleted: cleaned.deleted,
			discovered: members.length + invitations.length,
			resealed,
			stale,
			unrecoverable
		};
	}

	async #resealMember(
		row: InstanceMemberDisplayRow,
		now: string
	): Promise<'resealed' | 'stale' | 'unrecoverable'> {
		if (this.#sealer === null) return 'unrecoverable';
		let payload;
		try {
			payload = await this.#sealer.openMember(row.sealedPayload, row.userId, row.sealingKeyId);
		} catch {
			return await this.#deferMember(row, now);
		}
		let sealed;
		try {
			sealed = await this.#sealer.sealMember(payload, row.userId);
		} catch {
			return await this.#deferMember(row, now);
		}
		try {
			return await this.#store.casResealMemberSnapshot({
				userId: row.userId,
				previousSealingKeyId: row.sealingKeyId,
				previousObservedAt: row.observedAt,
				previousExpiresAt: row.expiresAt,
				previousSealedPayload: row.sealedPayload,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				storedAt: now
			});
		} catch {
			return 'unrecoverable';
		}
	}

	async #resealInvitation(
		row: InstanceInvitationDisplayRow,
		now: string
	): Promise<'resealed' | 'stale' | 'unrecoverable'> {
		if (this.#sealer === null) return 'unrecoverable';
		let payload;
		try {
			payload = await this.#sealer.openInvitationTarget(
				row.sealedPayload,
				row.invitationId,
				row.sealingKeyId
			);
		} catch {
			return await this.#deferInvitation(row, now);
		}
		let sealed;
		try {
			sealed = await this.#sealer.sealInvitationTarget(payload, row.invitationId);
		} catch {
			return await this.#deferInvitation(row, now);
		}
		try {
			return await this.#store.casResealInvitationTarget({
				invitationId: row.invitationId,
				previousSealingKeyId: row.sealingKeyId,
				previousSealedPayload: row.sealedPayload,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				now
			});
		} catch {
			return 'unrecoverable';
		}
	}

	async #deferMember(
		row: InstanceMemberDisplayRow,
		now: string
	): Promise<'stale' | 'unrecoverable'> {
		try {
			const deferred = await this.#store.deferMemberReseal({
				userId: row.userId,
				previousSealingKeyId: row.sealingKeyId,
				previousObservedAt: row.observedAt,
				previousExpiresAt: row.expiresAt,
				previousSealedPayload: row.sealedPayload,
				now
			});
			return deferred === 'deferred' ? 'unrecoverable' : 'stale';
		} catch {
			return 'unrecoverable';
		}
	}

	async #deferInvitation(
		row: InstanceInvitationDisplayRow,
		now: string
	): Promise<'stale' | 'unrecoverable'> {
		try {
			const deferred = await this.#store.deferInvitationReseal({
				invitationId: row.invitationId,
				previousSealingKeyId: row.sealingKeyId,
				previousSealedPayload: row.sealedPayload,
				now
			});
			return deferred === 'deferred' ? 'unrecoverable' : 'stale';
		} catch {
			return 'unrecoverable';
		}
	}
}
