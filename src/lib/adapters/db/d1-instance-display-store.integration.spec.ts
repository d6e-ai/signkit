import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InstanceDisplayStore } from './d1-instance-display-store';
import { D1InstanceStore } from './d1-instance-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import { memberDisplayExpiresAt } from '$lib/domain/instance-display';
import { AesGcmInstanceDisplayPayloadSealer } from '$lib/security/instance-display-payload';
import type { CreateInstanceInvitationCommand } from '$lib/ports/instance-store';

const OWNER_ID: string = 'owner-1';
const ADMIN_ID: string = 'admin-1';
const MEMBER_ID: string = 'member-1';
const TARGET_ID: string = 'target-1';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-09-19T12:00:00.000Z';
const OBSERVED_AT: string = '2026-09-12T12:00:00.000Z';
const LATER_AT: string = '2026-09-13T12:00:00.000Z';
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000301';
const TOKEN_HASH: string = 'c'.repeat(64);
const EMAIL_BINDING: string = 'e'.repeat(64);
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

function migrated(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

function insertMember(
	sqlite: DatabaseSync,
	userId: string,
	role: 'owner' | 'admin' | 'member' = 'member',
	status: 'active' | 'suspended' = 'active'
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${userId}', '${role}', '${status}', '${CREATED_AT}', '${CREATED_AT}')
	`);
}

function createCommand(
	overrides: Partial<CreateInstanceInvitationCommand> = {}
): CreateInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'create-display-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		invitationId: INVITATION_ID,
		role: 'member',
		tokenHash: TOKEN_HASH,
		emailBinding: EMAIL_BINDING,
		deliveryId: INVITATION_ID,
		deliveryLocale: 'ja',
		sealedDeliveryPayload: 'skiod1_testpayload',
		deliverySealingKeyId: 'a'.repeat(16),
		sealedDeliveryPayloadSha256: 'd'.repeat(64),
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
		...overrides
	};
}

describe('D1 instance display store', () => {
	it('creates additive display tables without changing instance_member columns', () => {
		const { sqlite } = migrated();
		const memberColumns = sqlite.prepare('PRAGMA table_info(instance_member)').all() as {
			name: string;
		}[];
		expect(memberColumns.map(({ name }) => name)).toEqual([
			'user_id',
			'role',
			'status',
			'created_at',
			'updated_at'
		]);
		const tables = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[];
		expect(tables.map(({ name }) => name)).toEqual(
			expect.arrayContaining(['instance_member_display', 'instance_invitation_display'])
		);
	});

	it('records only self snapshots for the active member and ignores older observations', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		insertMember(sqlite, MEMBER_ID, 'member', 'suspended');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new D1InstanceDisplayStore(d1);
		const expiresAt: string = memberDisplayExpiresAt(OBSERVED_AT);
		const sealed = await sealer.sealMember(
			{ name: 'Ada', email: 'ada@example.com', observedAt: OBSERVED_AT, expiresAt },
			OWNER_ID
		);
		expect(
			await store.recordMemberSnapshot({
				userId: OWNER_ID,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				observedAt: OBSERVED_AT,
				expiresAt,
				storedAt: OBSERVED_AT
			})
		).toEqual({ outcome: 'recorded' });
		expect(
			await store.recordMemberSnapshot({
				userId: OWNER_ID,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				observedAt: OBSERVED_AT,
				expiresAt,
				storedAt: LATER_AT
			})
		).toEqual({ outcome: 'unchanged' });
		const laterExpires: string = memberDisplayExpiresAt(LATER_AT);
		const later = await sealer.sealMember(
			{
				name: 'Ada Lovelace',
				email: 'ada@example.com',
				observedAt: LATER_AT,
				expiresAt: laterExpires
			},
			OWNER_ID
		);
		expect(
			await store.recordMemberSnapshot({
				userId: OWNER_ID,
				sealedPayload: later.sealedPayload,
				sealingKeyId: later.sealingKeyId,
				observedAt: LATER_AT,
				expiresAt: laterExpires,
				storedAt: LATER_AT
			})
		).toEqual({ outcome: 'recorded' });
		expect(
			await store.recordMemberSnapshot({
				userId: MEMBER_ID,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				observedAt: OBSERVED_AT,
				expiresAt,
				storedAt: OBSERVED_AT
			})
		).toEqual({ outcome: 'skipped' });
	});

	it('lists only the authorized page ids for an active owner and denies members', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		insertMember(sqlite, ADMIN_ID, 'admin');
		insertMember(sqlite, MEMBER_ID, 'member');
		insertMember(sqlite, TARGET_ID, 'member');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new D1InstanceDisplayStore(d1);
		const expiresAt: string = memberDisplayExpiresAt(OBSERVED_AT);
		for (const userId of [OWNER_ID, MEMBER_ID, TARGET_ID]) {
			const sealed = await sealer.sealMember(
				{ name: userId, email: `${userId}@example.com`, observedAt: OBSERVED_AT, expiresAt },
				userId
			);
			await store.recordMemberSnapshot({
				userId,
				sealedPayload: sealed.sealedPayload,
				sealingKeyId: sealed.sealingKeyId,
				observedAt: OBSERVED_AT,
				expiresAt,
				storedAt: OBSERVED_AT
			});
		}
		const listed = await store.listMemberDisplayRows({ type: 'user', id: OWNER_ID }, [
			MEMBER_ID,
			'missing-user'
		]);
		expect(listed.outcome).toBe('listed');
		if (listed.outcome !== 'listed') return;
		expect(listed.rows.map((row) => row.userId)).toEqual([MEMBER_ID]);
		expect(listed.rows[0]?.sealedPayload).toMatch(/^skidm1_/);
		expect(await store.listMemberDisplayRows({ type: 'user', id: MEMBER_ID }, [OWNER_ID])).toEqual({
			outcome: 'forbidden'
		});
		sqlite.exec(`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ADMIN_ID}'`);
		expect(await store.listMemberDisplayRows({ type: 'user', id: ADMIN_ID }, [MEMBER_ID])).toEqual({
			outcome: 'member_suspended'
		});
	});

	it('scrubs invitation targets on accept and does not recreate them on exact replay', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const instance = new D1InstanceStore(d1);
		const display = new D1InstanceDisplayStore(d1);
		const sealed = await sealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		const created = await instance.createInstanceInvitation(
			createCommand({
				sealedDisplayPayload: sealed.sealedPayload,
				displaySealingKeyId: sealed.sealingKeyId
			})
		);
		expect(created.outcome).toBe('created');
		const pending = await display.listInvitationDisplayRows({ type: 'user', id: OWNER_ID }, [
			INVITATION_ID
		]);
		expect(pending.outcome).toBe('listed');
		if (pending.outcome !== 'listed') return;
		expect(pending.rows).toHaveLength(1);

		const accepted = await instance.acceptInstanceInvitation({
			actor: { type: 'user', id: TARGET_ID },
			idempotencyKey: 'accept-display-1',
			requestFingerprint: 'b'.repeat(64),
			tokenHash: TOKEN_HASH,
			emailBinding: EMAIL_BINDING,
			acceptedAt: LATER_AT
		});
		expect(accepted.outcome).toBe('accepted');
		const afterAccept = await display.listInvitationDisplayRows({ type: 'user', id: OWNER_ID }, [
			INVITATION_ID
		]);
		expect(afterAccept.outcome).toBe('listed');
		if (afterAccept.outcome !== 'listed') return;
		expect(afterAccept.rows).toHaveLength(0);

		const replayed = await instance.createInstanceInvitation(
			createCommand({
				sealedDisplayPayload: sealed.sealedPayload,
				displaySealingKeyId: sealed.sealingKeyId
			})
		);
		expect(replayed.outcome).toBe('replayed');
		const afterReplay = await display.listInvitationDisplayRows({ type: 'user', id: OWNER_ID }, [
			INVITATION_ID
		]);
		expect(afterReplay.outcome).toBe('listed');
		if (afterReplay.outcome !== 'listed') return;
		expect(afterReplay.rows).toHaveLength(0);
	});

	it('binds member snapshots to instance_member with ON DELETE CASCADE', () => {
		const { sqlite } = migrated();
		const foreignKeys = sqlite
			.prepare('PRAGMA foreign_key_list(instance_member_display)')
			.all() as {
			table: string;
			from: string;
			on_delete: string;
		}[];
		expect(foreignKeys).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					table: 'instance_member',
					from: 'user_id',
					on_delete: 'CASCADE'
				})
			])
		);
	});

	it('cleans expired rows and CAS-reseals only still-live previous-key ciphertext', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		insertMember(sqlite, MEMBER_ID, 'member');
		const oldSealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const rotated = new AesGcmInstanceDisplayPayloadSealer(key(2), key(1));
		const store = new D1InstanceDisplayStore(d1);
		const liveObserved: string = '2026-09-01T00:00:00.000Z';
		const expiredObserved: string = '2026-01-01T00:00:00.000Z';
		const now: string = '2026-09-12T12:00:00.000Z';
		const liveExpires: string = memberDisplayExpiresAt(liveObserved);
		const expiredExpires: string = memberDisplayExpiresAt(expiredObserved);
		const live = await oldSealer.sealMember(
			{ name: 'Live', email: 'live@example.com', observedAt: liveObserved, expiresAt: liveExpires },
			OWNER_ID
		);
		const expired = await oldSealer.sealMember(
			{
				name: 'Old',
				email: 'old@example.com',
				observedAt: expiredObserved,
				expiresAt: expiredExpires
			},
			MEMBER_ID
		);
		await store.recordMemberSnapshot({
			userId: OWNER_ID,
			sealedPayload: live.sealedPayload,
			sealingKeyId: live.sealingKeyId,
			observedAt: liveObserved,
			expiresAt: liveExpires,
			storedAt: liveObserved
		});
		sqlite.exec(`
			INSERT INTO instance_member_display (
				user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
			) VALUES (
				'${MEMBER_ID}', '${expired.sealedPayload}', '${expired.sealingKeyId}',
				'${expiredObserved}', '${expiredExpires}', '${expiredObserved}'
			)
		`);
		const cleaned = await store.cleanupExpired(now, 100);
		expect(cleaned.expired).toBe(1);
		const stale = await store.findMemberRowsForReseal(await rotated.memberActiveKeyId(), now, 50);
		expect(stale).toHaveLength(1);
		expect(stale[0]?.userId).toBe(OWNER_ID);
		const opened = await rotated.openMember(
			stale[0]!.sealedPayload,
			OWNER_ID,
			stale[0]!.sealingKeyId
		);
		const resealed = await rotated.sealMember(opened, OWNER_ID);
		expect(
			await store.casResealMemberSnapshot({
				userId: OWNER_ID,
				previousSealingKeyId: stale[0]!.sealingKeyId,
				previousObservedAt: liveObserved,
				previousExpiresAt: liveExpires,
				sealedPayload: resealed.sealedPayload,
				sealingKeyId: resealed.sealingKeyId,
				storedAt: now
			})
		).toBe('resealed');
		expect(
			await store.casResealMemberSnapshot({
				userId: OWNER_ID,
				previousSealingKeyId: stale[0]!.sealingKeyId,
				previousObservedAt: liveObserved,
				previousExpiresAt: liveExpires,
				sealedPayload: resealed.sealedPayload,
				sealingKeyId: resealed.sealingKeyId,
				storedAt: now
			})
		).toBe('stale');
	});
});
