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
	readonly deferredMemberIds: Set<string> = new Set();
	readonly deferredInvitationIds: Set<string> = new Set();
	readonly findLimits: { members: number; invitations: number }[] = [];

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

	async findMemberRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceMemberDisplayRow[]> {
		this.findLimits.push({ members: limit, invitations: -1 });
		return this.memberRows
			.filter(
				(row: InstanceMemberDisplayRow): boolean =>
					row.sealingKeyId === previousSealingKeyId &&
					row.expiresAt > now &&
					!this.deferredMemberIds.has(row.userId)
			)
			.slice(0, Math.max(0, limit));
	}

	async findInvitationRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceInvitationDisplayRow[]> {
		this.findLimits.push({ members: -1, invitations: limit });
		return this.invitationRows
			.filter(
				(row: InstanceInvitationDisplayRow): boolean =>
					row.sealingKeyId === previousSealingKeyId &&
					row.expiresAt > now &&
					!this.deferredInvitationIds.has(row.invitationId)
			)
			.slice(0, Math.max(0, limit));
	}

	async casResealMemberSnapshot(command: {
		userId: string;
		previousSealingKeyId: string;
		previousSealedPayload: string;
		sealedPayload: string;
		sealingKeyId: string;
		storedAt: string;
	}): Promise<'resealed' | 'stale'> {
		const row: InstanceMemberDisplayRow | undefined = this.memberRows.find(
			(candidate: InstanceMemberDisplayRow): boolean => candidate.userId === command.userId
		);
		if (
			row === undefined ||
			row.sealingKeyId !== command.previousSealingKeyId ||
			row.sealedPayload !== command.previousSealedPayload
		) {
			return 'stale';
		}
		row.sealedPayload = command.sealedPayload;
		row.sealingKeyId = command.sealingKeyId;
		row.storedAt = command.storedAt;
		return 'resealed';
	}

	async casResealInvitationTarget(command: {
		invitationId: string;
		previousSealingKeyId: string;
		previousSealedPayload: string;
		sealedPayload: string;
		sealingKeyId: string;
	}): Promise<'resealed' | 'stale'> {
		const row: InstanceInvitationDisplayRow | undefined = this.invitationRows.find(
			(candidate: InstanceInvitationDisplayRow): boolean =>
				candidate.invitationId === command.invitationId
		);
		if (
			row === undefined ||
			row.sealingKeyId !== command.previousSealingKeyId ||
			row.sealedPayload !== command.previousSealedPayload
		) {
			return 'stale';
		}
		row.sealedPayload = command.sealedPayload;
		row.sealingKeyId = command.sealingKeyId;
		return 'resealed';
	}

	async deferMemberReseal(command: { userId: string }): Promise<'deferred' | 'stale'> {
		const row: InstanceMemberDisplayRow | undefined = this.memberRows.find(
			(candidate: InstanceMemberDisplayRow): boolean => candidate.userId === command.userId
		);
		if (row === undefined) return 'stale';
		this.deferredMemberIds.add(command.userId);
		return 'deferred';
	}

	async deferInvitationReseal(command: { invitationId: string }): Promise<'deferred' | 'stale'> {
		const row: InstanceInvitationDisplayRow | undefined = this.invitationRows.find(
			(candidate: InstanceInvitationDisplayRow): boolean =>
				candidate.invitationId === command.invitationId
		);
		if (row === undefined) return 'stale';
		this.deferredInvitationIds.add(command.invitationId);
		return 'deferred';
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

	it('preserves __proto__ and constructor subject ids as own display keys', async () => {
		const store = new MemoryDisplayStore();
		const app = new InstanceDisplayApplication(store, null);
		const members: InstanceMemberMetadata[] = [
			{
				userId: '__proto__',
				role: 'member',
				status: 'active',
				createdAt: NOW,
				updatedAt: NOW
			},
			{
				userId: 'constructor',
				role: 'member',
				status: 'active',
				createdAt: NOW,
				updatedAt: NOW
			}
		];
		const displays = await app.memberDisplays({ type: 'user', id: USER_ID }, members, NOW);
		expect(Object.getPrototypeOf(displays)).toBeNull();
		expect(Object.hasOwn(displays, '__proto__')).toBe(true);
		expect(Object.hasOwn(displays, 'constructor')).toBe(true);
		expect(displays['__proto__']).toEqual({ state: 'unavailable' });
		expect(displays['constructor']).toEqual({ state: 'unavailable' });
		expect(JSON.parse(JSON.stringify(displays))['__proto__']).toEqual({ state: 'unavailable' });
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

	it('reseals healthy previous-key rows after deferring a full poison batch, including invitations', async () => {
		const oldSealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const rotated = new AesGcmInstanceDisplayPayloadSealer(key(2), key(1));
		const previousMemberKeyId: string = await oldSealer.memberActiveKeyId();
		const previousInvitationKeyId: string = await oldSealer.invitationActiveKeyId();
		const store = new MemoryDisplayStore();
		const liveExpires: string = memberDisplayExpiresAt(NOW);
		const poisonMemberObserved: string = '2026-06-21T00:00:00.000Z';
		for (const userId of ['poison-0', 'poison-1']) {
			store.memberRows.push({
				userId,
				sealedPayload: `skidm1_${'A'.repeat(40)}`,
				sealingKeyId: previousMemberKeyId,
				observedAt: poisonMemberObserved,
				expiresAt: memberDisplayExpiresAt(poisonMemberObserved),
				storedAt: poisonMemberObserved
			});
		}
		store.memberRows.push({
			userId: 'unknown-member',
			sealedPayload: `skidm1_${'B'.repeat(40)}`,
			sealingKeyId: 'deadbeefdeadbeef',
			observedAt: '2026-06-20T00:00:00.000Z',
			expiresAt: memberDisplayExpiresAt('2026-06-20T00:00:00.000Z'),
			storedAt: '2026-06-20T00:00:00.000Z'
		});
		const healthyMember = await oldSealer.sealMember(
			{ name: 'Ada', email: 'ada@example.com', observedAt: NOW, expiresAt: liveExpires },
			USER_ID
		);
		store.memberRows.push({
			userId: USER_ID,
			sealedPayload: healthyMember.sealedPayload,
			sealingKeyId: healthyMember.sealingKeyId,
			observedAt: NOW,
			expiresAt: liveExpires,
			storedAt: NOW
		});
		const poisonInvitationIds: string[] = [
			'01900000-0000-7000-8000-000000000601',
			'01900000-0000-7000-8000-000000000602'
		];
		for (const invitationId of poisonInvitationIds) {
			store.invitationRows.push({
				invitationId,
				sealedPayload: `skidt1_${'A'.repeat(40)}`,
				sealingKeyId: previousInvitationKeyId,
				createdAt: NOW,
				expiresAt: '2026-09-17T12:00:00.000Z'
			});
		}
		store.invitationRows.push({
			invitationId: '01900000-0000-7000-8000-000000000600',
			sealedPayload: `skidt1_${'B'.repeat(40)}`,
			sealingKeyId: 'deadbeefdeadbeef',
			createdAt: NOW,
			expiresAt: '2026-09-16T12:00:00.000Z'
		});
		const healthyInvitation = await oldSealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		store.invitationRows.push({
			invitationId: INVITATION_ID,
			sealedPayload: healthyInvitation.sealedPayload,
			sealingKeyId: healthyInvitation.sealingKeyId,
			createdAt: NOW,
			expiresAt: '2026-09-19T12:00:00.000Z'
		});

		const service = new InstanceDisplayMaintenanceService(store, rotated, () => new Date(NOW));
		expect(await service.maintain(100, 4)).toEqual({
			expired: 0,
			deleted: 0,
			discovered: 4,
			resealed: 0,
			stale: 0,
			unrecoverable: 4
		});
		expect(
			store.findLimits.filter((call) => call.members >= 0).map((call) => call.members)
		).toEqual([2]);
		expect(
			store.findLimits.filter((call) => call.invitations >= 0).map((call) => call.invitations)
		).toEqual([2]);
		expect(store.deferredMemberIds.size).toBe(2);
		expect(store.deferredInvitationIds.size).toBe(2);
		expect(store.memberRows.find((row) => row.userId === USER_ID)?.sealingKeyId).toBe(
			previousMemberKeyId
		);
		expect(
			store.invitationRows.find((row) => row.invitationId === INVITATION_ID)?.sealingKeyId
		).toBe(previousInvitationKeyId);

		expect(await service.maintain(100, 4)).toMatchObject({
			discovered: 2,
			resealed: 2,
			stale: 0,
			unrecoverable: 0
		});
		expect(store.memberRows.find((row) => row.userId === USER_ID)?.sealingKeyId).toBe(
			await rotated.memberActiveKeyId()
		);
		expect(
			store.invitationRows.find((row) => row.invitationId === INVITATION_ID)?.sealingKeyId
		).toBe(await rotated.invitationActiveKeyId());
		expect(store.memberRows.find((row) => row.userId === 'unknown-member')?.sealingKeyId).toBe(
			'deadbeefdeadbeef'
		);
		expect(
			store.invitationRows.find(
				(row) => row.invitationId === '01900000-0000-7000-8000-000000000600'
			)?.sealingKeyId
		).toBe('deadbeefdeadbeef');
		expect(store.memberRows.find((row) => row.userId === 'poison-0')?.sealedPayload).toBe(
			`skidm1_${'A'.repeat(40)}`
		);
	});
});
