import {
	allowlistedInvitationDisplay,
	allowlistedMemberDisplay,
	invitationDisplayState,
	isUsableDisplayName,
	memberDisplayExpiresAt,
	projectAvailableMemberDisplay,
	unavailableInvitationDisplay,
	unavailableMemberDisplay
} from '$lib/domain/instance-display';
import type {
	InvitationDisplay,
	InstanceDisplayStore,
	InstanceInvitationDisplayRow,
	InstanceMemberDisplayRow,
	MemberDisplay,
	RecordMemberDisplaySnapshotResult
} from '$lib/ports/instance-display-store';
import type {
	InstanceActor,
	InstanceInvitationMetadata,
	InstanceMemberMetadata
} from '$lib/ports/instance-store';
import { normalizeInstanceInvitationEmail } from '$lib/security/instance-invitation';
import type {
	InstanceDisplayPayloadSealer,
	MemberDisplayPayload
} from '$lib/security/instance-display-payload';

export interface CaptureMemberDisplayInput {
	userId: string;
	name: string;
	email: string;
	observedAt: string;
	storedAt: string;
}

export type CaptureMemberDisplayResult = RecordMemberDisplaySnapshotResult | { outcome: 'failed' };

export interface InstanceDisplayApplicationPort {
	captureMemberSnapshot(input: CaptureMemberDisplayInput): Promise<CaptureMemberDisplayResult>;
	memberDisplays(
		actor: InstanceActor,
		members: readonly InstanceMemberMetadata[],
		now: string
	): Promise<Record<string, MemberDisplay>>;
	invitationDisplays(
		actor: InstanceActor,
		invitations: readonly InstanceInvitationMetadata[],
		now: string
	): Promise<Record<string, InvitationDisplay>>;
}

export class InstanceDisplayApplication implements InstanceDisplayApplicationPort {
	readonly #store: InstanceDisplayStore;
	readonly #sealer: InstanceDisplayPayloadSealer | null;

	constructor(store: InstanceDisplayStore, sealer: InstanceDisplayPayloadSealer | null) {
		this.#store = store;
		this.#sealer = sealer;
	}

	async captureMemberSnapshot(
		input: CaptureMemberDisplayInput
	): Promise<CaptureMemberDisplayResult> {
		if (this.#sealer === null) return { outcome: 'failed' };
		if (input.userId.length < 1 || input.userId.length > 200) return { outcome: 'failed' };
		let email: string;
		try {
			email = normalizeInstanceInvitationEmail(input.email);
		} catch {
			return { outcome: 'failed' };
		}
		const name: string = input.name.trim().normalize('NFC');
		if (!isUsableDisplayName(name)) return { outcome: 'failed' };
		let expiresAt: string;
		try {
			expiresAt = memberDisplayExpiresAt(input.observedAt);
		} catch {
			return { outcome: 'failed' };
		}
		let sealed;
		try {
			sealed = await this.#sealer.sealMember(
				{ name, email, observedAt: input.observedAt, expiresAt },
				input.userId
			);
		} catch {
			return { outcome: 'failed' };
		}
		try {
			return await this.#store.recordMemberSnapshot({
				userId: input.userId,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				observedAt: input.observedAt,
				expiresAt,
				storedAt: input.storedAt
			});
		} catch {
			return { outcome: 'failed' };
		}
	}

	async memberDisplays(
		actor: InstanceActor,
		members: readonly InstanceMemberMetadata[],
		now: string
	): Promise<Record<string, MemberDisplay>> {
		const displays: Record<string, MemberDisplay> = {};
		for (const member of members) {
			displays[member.userId] = unavailableMemberDisplay();
		}
		if (this.#sealer === null || members.length === 0) return displays;
		try {
			const listed = await this.#store.listMemberDisplayRows(
				actor,
				members.map((member: InstanceMemberMetadata): string => member.userId)
			);
			if (listed.outcome !== 'listed') return displays;
			const byUserId: Map<string, InstanceMemberDisplayRow> = new Map(
				listed.rows.map((row: InstanceMemberDisplayRow): [string, InstanceMemberDisplayRow] => [
					row.userId,
					row
				])
			);
			for (const member of members) {
				const row: InstanceMemberDisplayRow | undefined = byUserId.get(member.userId);
				displays[member.userId] = allowlistedMemberDisplay(
					await this.#openMember(row, member.userId, now)
				);
			}
		} catch {
			return displays;
		}
		return displays;
	}

	async invitationDisplays(
		actor: InstanceActor,
		invitations: readonly InstanceInvitationMetadata[],
		now: string
	): Promise<Record<string, InvitationDisplay>> {
		const displays: Record<string, InvitationDisplay> = {};
		for (const invitation of invitations) {
			displays[invitation.id] = unavailableInvitationDisplay();
		}
		if (invitations.length === 0) return displays;
		const acceptedUserIds: string[] = [];
		for (const invitation of invitations) {
			const state = invitationDisplayState(invitation, now);
			if (state === 'redacted') {
				displays[invitation.id] = { state: 'redacted' };
			}
			if (state === 'accepted' && invitation.acceptedByUserId !== null) {
				acceptedUserIds.push(invitation.acceptedByUserId);
			}
		}
		if (this.#sealer === null) return displays;
		try {
			const listed = await this.#store.listInvitationDisplayRows(
				actor,
				invitations.map((invitation: InstanceInvitationMetadata): string => invitation.id)
			);
			if (listed.outcome !== 'listed') return displays;
			const byInvitationId: Map<string, InstanceInvitationDisplayRow> = new Map(
				listed.rows.map(
					(row: InstanceInvitationDisplayRow): [string, InstanceInvitationDisplayRow] => [
						row.invitationId,
						row
					]
				)
			);
			const memberDisplays: Record<string, MemberDisplay> =
				acceptedUserIds.length === 0
					? {}
					: await this.memberDisplays(
							actor,
							acceptedUserIds.map((userId: string): InstanceMemberMetadata => ({
								userId,
								role: 'member',
								status: 'active',
								createdAt: now,
								updatedAt: now
							})),
							now
						);
			for (const invitation of invitations) {
				const state = invitationDisplayState(invitation, now);
				if (state === 'redacted') {
					displays[invitation.id] = allowlistedInvitationDisplay({ state: 'redacted' });
					continue;
				}
				if (state === 'accepted') {
					const memberId: string | null = invitation.acceptedByUserId;
					displays[invitation.id] = allowlistedInvitationDisplay({
						state: 'accepted',
						member:
							memberId === null
								? unavailableMemberDisplay()
								: (memberDisplays[memberId] ?? unavailableMemberDisplay())
					});
					continue;
				}
				const row: InstanceInvitationDisplayRow | undefined = byInvitationId.get(invitation.id);
				displays[invitation.id] = allowlistedInvitationDisplay(
					await this.#openInvitationTarget(row, invitation.id)
				);
			}
		} catch {
			return displays;
		}
		return displays;
	}

	async #openMember(
		row: InstanceMemberDisplayRow | undefined,
		userId: string,
		now: string
	): Promise<MemberDisplay> {
		if (row === undefined || this.#sealer === null) return unavailableMemberDisplay();
		let payload: MemberDisplayPayload;
		try {
			payload = await this.#sealer.openMember(row.sealedPayload, userId, row.sealingKeyId);
		} catch {
			return unavailableMemberDisplay();
		}
		if (payload.observedAt !== row.observedAt || payload.expiresAt !== row.expiresAt) {
			return unavailableMemberDisplay();
		}
		return projectAvailableMemberDisplay({ ...payload, now });
	}

	async #openInvitationTarget(
		row: InstanceInvitationDisplayRow | undefined,
		invitationId: string
	): Promise<InvitationDisplay> {
		if (row === undefined || this.#sealer === null) return unavailableInvitationDisplay();
		try {
			const payload = await this.#sealer.openInvitationTarget(
				row.sealedPayload,
				invitationId,
				row.sealingKeyId
			);
			return { state: 'pending', email: payload.email };
		} catch {
			return unavailableInvitationDisplay();
		}
	}
}
