import { describe, expect, it } from 'vitest';
import { memberDisplayExpiresAt } from '$lib/domain/instance-display';
import type {
	InstanceDisplayStore,
	InstanceInvitationDisplayRow,
	InstanceMemberDisplayRow,
	ListInstanceDisplayRowsResult,
	RecordMemberDisplaySnapshotResult
} from '$lib/ports/instance-display-store';
import type { InstanceInvitationMetadata, InstanceMemberMetadata } from '$lib/ports/instance-store';
import { AesGcmInstanceDisplayPayloadSealer } from '$lib/security/instance-display-payload';
import { InstanceDisplayApplication } from './instance-display-service';
import { InstanceDisplayMaintenanceService } from './instance-display-maintenance-service';

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

const NOW: string = '2026-09-12T12:00:00.000Z';
const USER_ID: string = 'user-1';
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000501';

class MemoryDisplayStore implements InstanceDisplayStore {
	memberRows: InstanceMemberDisplayRow[] = [];
	invitationRows: InstanceInvitationDisplayRow[] = [];
	actorOutcome: 'listed' | 'forbidden' | 'member_suspended' = 'listed';

	async recordMemberSnapshot(): Promise<RecordMemberDisplaySnapshotResult> {
		return { outcome: 'recorded' };
	}

	async listMemberDisplayRows(): Promise<ListInstanceDisplayRowsResult<InstanceMemberDisplayRow>> {
		if (this.actorOutcome !== 'listed') return { outcome: this.actorOutcome };
		return { outcome: 'listed', rows: this.memberRows };
	}

	async listInvitationDisplayRows(): Promise<
		ListInstanceDisplayRowsResult<InstanceInvitationDisplayRow>
	> {
		if (this.actorOutcome !== 'listed') return { outcome: this.actorOutcome };
		return { outcome: 'listed', rows: this.invitationRows };
	}

	cleanupExpired: InstanceDisplayStore['cleanupExpired'] = async (): Promise<{
		expired: number;
		deleted: number;
	}> => ({ expired: 0, deleted: 0 });

	async findMemberRowsForReseal(): Promise<readonly InstanceMemberDisplayRow[]> {
		return this.memberRows;
	}

	async findInvitationRowsForReseal(): Promise<readonly InstanceInvitationDisplayRow[]> {
		return this.invitationRows;
	}

	async casResealMemberSnapshot(): Promise<'resealed' | 'stale'> {
		return 'resealed';
	}

	async casResealInvitationTarget(): Promise<'resealed' | 'stale'> {
		return 'resealed';
	}
}

describe('InstanceDisplayApplication', () => {
	it('allowlists available member fields and maps corrupt rows to unavailable', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new MemoryDisplayStore();
		const expiresAt: string = memberDisplayExpiresAt(NOW);
		const sealed = await sealer.sealMember(
			{ name: 'Ada', email: 'ada@example.com', observedAt: NOW, expiresAt },
			USER_ID
		);
		store.memberRows = [
			{
				userId: USER_ID,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				observedAt: NOW,
				expiresAt,
				storedAt: NOW
			}
		];
		const app = new InstanceDisplayApplication(store, sealer);
		const members: InstanceMemberMetadata[] = [
			{
				userId: USER_ID,
				role: 'owner',
				status: 'active',
				createdAt: NOW,
				updatedAt: NOW
			}
		];
		expect(await app.memberDisplays({ type: 'user', id: USER_ID }, members, NOW)).toEqual({
			[USER_ID]: {
				state: 'available',
				name: 'Ada',
				email: 'ada@example.com',
				observedAt: NOW,
				expiresAt
			}
		});
		store.memberRows[0]!.sealedPayload = 'skidm1_not-ciphertext';
		expect(await app.memberDisplays({ type: 'user', id: USER_ID }, members, NOW)).toEqual({
			[USER_ID]: { state: 'unavailable' }
		});
	});

	it('projects invitation pending, accepted, redacted, and unavailable states', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new MemoryDisplayStore();
		const sealed = await sealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		store.invitationRows = [
			{
				invitationId: INVITATION_ID,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				createdAt: NOW,
				expiresAt: '2026-09-19T12:00:00.000Z'
			}
		];
		const app = new InstanceDisplayApplication(store, sealer);
		const pending: InstanceInvitationMetadata = {
			id: INVITATION_ID,
			role: 'member',
			status: 'pending',
			invitedByUserId: USER_ID,
			createdAt: NOW,
			expiresAt: '2026-09-19T12:00:00.000Z',
			acceptedAt: null,
			acceptedByUserId: null,
			revokedAt: null,
			revokedByUserId: null
		};
		expect(await app.invitationDisplays({ type: 'user', id: USER_ID }, [pending], NOW)).toEqual({
			[INVITATION_ID]: { state: 'pending', email: 'invitee@example.com' }
		});
		expect(
			await app.invitationDisplays(
				{ type: 'user', id: USER_ID },
				[{ ...pending, status: 'revoked', revokedAt: NOW, revokedByUserId: USER_ID }],
				NOW
			)
		).toEqual({ [INVITATION_ID]: { state: 'redacted' } });
		expect(
			await app.invitationDisplays(
				{ type: 'user', id: USER_ID },
				[{ ...pending, expiresAt: '2026-09-12T11:00:00.000Z' }],
				NOW
			)
		).toEqual({ [INVITATION_ID]: { state: 'redacted' } });
		expect(await app.invitationDisplays({ type: 'user', id: USER_ID }, [pending], NOW)).toEqual({
			[INVITATION_ID]: { state: 'pending', email: 'invitee@example.com' }
		});
		store.invitationRows = [];
		expect(await app.invitationDisplays({ type: 'user', id: USER_ID }, [pending], NOW)).toEqual({
			[INVITATION_ID]: { state: 'unavailable' }
		});
	});

	it('keeps metadata usable when the sealer is missing', async () => {
		const store = new MemoryDisplayStore();
		const app = new InstanceDisplayApplication(store, null);
		const members: InstanceMemberMetadata[] = [
			{
				userId: USER_ID,
				role: 'owner',
				status: 'active',
				createdAt: NOW,
				updatedAt: NOW
			}
		];
		expect(await app.memberDisplays({ type: 'user', id: USER_ID }, members, NOW)).toEqual({
			[USER_ID]: { state: 'unavailable' }
		});
	});
});

describe('InstanceDisplayMaintenanceService', () => {
	it('runs cleanup without a sealer and skips reseal', async () => {
		const store = new MemoryDisplayStore();
		store.cleanupExpired = async (): Promise<{ expired: number; deleted: number }> => ({
			expired: 4,
			deleted: 2
		});
		const service = new InstanceDisplayMaintenanceService(store, null, () => new Date(NOW));
		await expect(service.maintain(100, 50)).resolves.toEqual({
			expired: 4,
			deleted: 2,
			discovered: 0,
			resealed: 0,
			stale: 0,
			unrecoverable: 0
		});
	});
});
