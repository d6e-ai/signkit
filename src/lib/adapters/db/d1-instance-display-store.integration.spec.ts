import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InstanceDisplayMaintenanceService } from '$lib/application/instance-display/instance-display-maintenance-service';
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

function invitationFixtureId(n: number): string {
	return `01900000-0000-7000-8a00-${n.toString(16).padStart(12, '0')}`;
}

function hex64(n: number): string {
	return n.toString(16).padStart(64, 'a');
}

function insertInvitation(
	sqlite: DatabaseSync,
	invitationId: string,
	createdAt: string,
	expiresAt: string,
	tokenSeed: number,
	status: 'pending' | 'accepted' | 'revoked' = 'pending'
): void {
	sqlite.exec(`
		INSERT INTO instance_invitation (
			id, role, status, token_hash, email_binding, invited_by_user_id,
			created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
		) VALUES (
			'${invitationId}', 'member', '${status}', '${hex64(tokenSeed)}', '${hex64(tokenSeed + 1000)}',
			'${OWNER_ID}', '${createdAt}', '${expiresAt}', NULL, NULL, NULL, NULL
		)
	`);
}

function insertInvitationDisplay(
	sqlite: DatabaseSync,
	invitationId: string,
	sealedPayload: string,
	sealingKeyId: string,
	createdAt: string,
	expiresAt: string
): void {
	sqlite.exec(`
		INSERT INTO instance_invitation_display (
			invitation_id, sealed_payload, sealing_key_id, created_at, expires_at
		) VALUES (
			'${invitationId}', '${sealedPayload}', '${sealingKeyId}', '${createdAt}', '${expiresAt}'
		)
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
		const stale = await store.findMemberRowsForReseal(
			(await rotated.memberPreviousKeyId()) as string,
			now,
			50
		);
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
				previousSealedPayload: stale[0]!.sealedPayload,
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
				previousSealedPayload: stale[0]!.sealedPayload,
				sealedPayload: resealed.sealedPayload,
				sealingKeyId: resealed.sealingKeyId,
				storedAt: now
			})
		).toBe('stale');
	});

	it('shares one cleanup budget across members and invitations and does not clamp remaining zero', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new D1InstanceDisplayStore(d1);
		const now: string = '2026-09-12T12:00:00.000Z';
		const expiredObserved: string = '2026-01-01T00:00:00.000Z';
		const expiredExpires: string = memberDisplayExpiresAt(expiredObserved);
		for (const userId of ['expired-a', 'expired-b', 'expired-c']) {
			insertMember(sqlite, userId);
			const sealed = await sealer.sealMember(
				{
					name: userId,
					email: `${userId}@example.com`,
					observedAt: expiredObserved,
					expiresAt: expiredExpires
				},
				userId
			);
			sqlite.exec(`
				INSERT INTO instance_member_display (
					user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
				) VALUES (
					'${userId}', '${sealed.sealedPayload}', '${sealed.sealingKeyId}',
					'${expiredObserved}', '${expiredExpires}', '${expiredObserved}'
				)
			`);
		}
		const invitationCreated: string = '2026-09-01T00:00:00.000Z';
		const invitationExpired: string = '2026-09-08T00:00:00.000Z';
		for (let index = 0; index < 3; index += 1) {
			const invitationId: string = invitationFixtureId(index + 1);
			const sealed = await sealer.sealInvitationTarget({ email: 'old@example.com' }, invitationId);
			insertInvitation(sqlite, invitationId, invitationCreated, invitationExpired, index + 1);
			insertInvitationDisplay(
				sqlite,
				invitationId,
				sealed.sealedPayload,
				sealed.sealingKeyId,
				invitationCreated,
				invitationExpired
			);
		}

		expect(await store.cleanupExpired(now, 0)).toEqual({ expired: 0, deleted: 0 });
		const mixed = await store.cleanupExpired(now, 4);
		expect(mixed).toEqual({ expired: 3, deleted: 1 });
		expect(
			sqlite.prepare('SELECT invitation_id FROM instance_invitation_display').all()
		).toHaveLength(2);

		insertMember(sqlite, 'expired-d');
		const extra = await sealer.sealMember(
			{
				name: 'expired-d',
				email: 'expired-d@example.com',
				observedAt: expiredObserved,
				expiresAt: expiredExpires
			},
			'expired-d'
		);
		sqlite.exec(`
			INSERT INTO instance_member_display (
				user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
			) VALUES (
				'expired-d', '${extra.sealedPayload}', '${extra.sealingKeyId}',
				'${expiredObserved}', '${expiredExpires}', '${expiredObserved}'
			)
		`);
		insertMember(sqlite, 'expired-e');
		const extraMember = await sealer.sealMember(
			{
				name: 'expired-e',
				email: 'expired-e@example.com',
				observedAt: expiredObserved,
				expiresAt: expiredExpires
			},
			'expired-e'
		);
		sqlite.exec(`
			INSERT INTO instance_member_display (
				user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
			) VALUES (
				'expired-e', '${extraMember.sealedPayload}', '${extraMember.sealingKeyId}',
				'${expiredObserved}', '${expiredExpires}', '${expiredObserved}'
			)
		`);
		expect(await store.cleanupExpired(now, 2)).toEqual({ expired: 2, deleted: 0 });
		expect(
			sqlite.prepare('SELECT invitation_id FROM instance_invitation_display').all()
		).toHaveLength(2);
	});

	it('qualifies invitation reseal columns and reseals a pending previous-key invitation', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		const oldSealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const rotated = new AesGcmInstanceDisplayPayloadSealer(key(2), key(1));
		const store = new D1InstanceDisplayStore(d1);
		const now: string = OBSERVED_AT;
		const invitationCreated: string = CREATED_AT;
		const invitationExpires: string = EXPIRES_AT;
		const displayCreated: string = '2026-09-12T12:00:00.001Z';
		const displayExpires: string = '2026-09-18T12:00:00.000Z';
		const sealed = await oldSealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		insertInvitation(sqlite, INVITATION_ID, invitationCreated, invitationExpires, 31);
		insertInvitationDisplay(
			sqlite,
			INVITATION_ID,
			sealed.sealedPayload,
			sealed.sealingKeyId,
			displayCreated,
			displayExpires
		);
		const found = await store.findInvitationRowsForReseal(
			(await rotated.invitationPreviousKeyId()) as string,
			now,
			50
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.createdAt).toBe(displayCreated);
		expect(found[0]?.expiresAt).toBe(displayExpires);
		expect(found[0]?.expiresAt).not.toBe(invitationExpires);

		const service = new InstanceDisplayMaintenanceService(store, rotated, () => new Date(now));
		expect(await service.maintain(100, 50)).toMatchObject({ discovered: 1, resealed: 1 });
		const after = sqlite
			.prepare(
				'SELECT sealing_key_id AS sealingKeyId FROM instance_invitation_display WHERE invitation_id = ?'
			)
			.get(INVITATION_ID) as { sealingKeyId: string };
		expect(after.sealingKeyId).toBe(await rotated.invitationActiveKeyId());
	});

	it('makes bounded progress past unknown and corrupt previous-key rows without mutating them', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		const oldSealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const rotated = new AesGcmInstanceDisplayPayloadSealer(key(2), key(1));
		const store = new D1InstanceDisplayStore(d1);
		const now: string = OBSERVED_AT;
		const previousMemberKeyId: string = (await rotated.memberPreviousKeyId()) as string;
		const previousInvitationKeyId: string = (await rotated.invitationPreviousKeyId()) as string;
		const poisonPayload: string = `skidm1_${'A'.repeat(40)}`;
		const poisonInvitationPayload: string = `skidt1_${'A'.repeat(40)}`;
		for (const [index, userId] of ['poison-0', 'poison-1'].entries()) {
			insertMember(sqlite, userId);
			const observedAt: string = `2026-06-2${index + 1}T00:00:00.000Z`;
			sqlite.exec(`
				INSERT INTO instance_member_display (
					user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
				) VALUES (
					'${userId}', '${poisonPayload}', '${previousMemberKeyId}',
					'${observedAt}', '${memberDisplayExpiresAt(observedAt)}', '${observedAt}'
				)
			`);
		}
		insertMember(sqlite, 'unknown-member');
		sqlite.exec(`
			INSERT INTO instance_member_display (
				user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
			) VALUES (
				'unknown-member', 'skidm1_${'B'.repeat(40)}', 'deadbeefdeadbeef',
				'2026-06-20T00:00:00.000Z', '${memberDisplayExpiresAt('2026-06-20T00:00:00.000Z')}',
				'2026-06-20T00:00:00.000Z'
			)
		`);
		insertMember(sqlite, MEMBER_ID);
		const healthyExpires: string = memberDisplayExpiresAt(now);
		const healthyMember = await oldSealer.sealMember(
			{ name: 'Live', email: 'live@example.com', observedAt: now, expiresAt: healthyExpires },
			MEMBER_ID
		);
		await store.recordMemberSnapshot({
			userId: MEMBER_ID,
			sealedPayload: healthyMember.sealedPayload,
			sealingKeyId: healthyMember.sealingKeyId,
			observedAt: now,
			expiresAt: healthyExpires,
			storedAt: now
		});
		for (const [index, invitationId] of [
			invitationFixtureId(21),
			invitationFixtureId(22)
		].entries()) {
			insertInvitation(
				sqlite,
				invitationId,
				'2026-09-10T00:00:00.000Z',
				'2026-09-17T00:00:00.000Z',
				21 + index
			);
			insertInvitationDisplay(
				sqlite,
				invitationId,
				poisonInvitationPayload,
				previousInvitationKeyId,
				'2026-09-10T00:00:00.000Z',
				'2026-09-17T00:00:00.000Z'
			);
		}
		insertInvitation(
			sqlite,
			invitationFixtureId(20),
			'2026-09-10T00:00:00.000Z',
			'2026-09-16T00:00:00.000Z',
			20
		);
		insertInvitationDisplay(
			sqlite,
			invitationFixtureId(20),
			`skidt1_${'B'.repeat(40)}`,
			'deadbeefdeadbeef',
			'2026-09-10T00:00:00.000Z',
			'2026-09-16T00:00:00.000Z'
		);
		const healthyInvitation = await oldSealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		insertInvitation(sqlite, INVITATION_ID, CREATED_AT, EXPIRES_AT, 30);
		insertInvitationDisplay(
			sqlite,
			INVITATION_ID,
			healthyInvitation.sealedPayload,
			healthyInvitation.sealingKeyId,
			CREATED_AT,
			EXPIRES_AT
		);

		const service = new InstanceDisplayMaintenanceService(store, rotated, () => new Date(now));
		expect(await service.maintain(100, 4)).toEqual({
			expired: 0,
			deleted: 0,
			discovered: 4,
			resealed: 0,
			stale: 0,
			unrecoverable: 4
		});
		expect(await service.maintain(100, 4)).toMatchObject({
			discovered: 2,
			resealed: 2,
			unrecoverable: 0
		});
		const memberRow = sqlite
			.prepare(
				'SELECT sealing_key_id AS sealingKeyId, sealed_payload AS sealedPayload FROM instance_member_display WHERE user_id = ?'
			)
			.get(MEMBER_ID) as { sealingKeyId: string; sealedPayload: string };
		expect(memberRow.sealingKeyId).toBe(await rotated.memberActiveKeyId());
		const invitationRow = sqlite
			.prepare(
				'SELECT sealing_key_id AS sealingKeyId FROM instance_invitation_display WHERE invitation_id = ?'
			)
			.get(INVITATION_ID) as { sealingKeyId: string };
		expect(invitationRow.sealingKeyId).toBe(await rotated.invitationActiveKeyId());
		const unknown = sqlite
			.prepare(
				'SELECT sealing_key_id AS sealingKeyId, sealed_payload AS sealedPayload FROM instance_member_display WHERE user_id = ?'
			)
			.get('unknown-member') as { sealingKeyId: string; sealedPayload: string };
		expect(unknown).toEqual({
			sealingKeyId: 'deadbeefdeadbeef',
			sealedPayload: `skidm1_${'B'.repeat(40)}`
		});
		const poison = sqlite
			.prepare(
				'SELECT sealed_payload AS sealedPayload FROM instance_member_display WHERE user_id = ?'
			)
			.get('poison-0') as { sealedPayload: string };
		expect(poison.sealedPayload).toBe(poisonPayload);
	});

	it('does not revive accepted invitation ciphertext through reseal or defer', async () => {
		const { sqlite, d1 } = migrated();
		insertMember(sqlite, OWNER_ID, 'owner');
		const oldSealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const rotated = new AesGcmInstanceDisplayPayloadSealer(key(2), key(1));
		const instance = new D1InstanceStore(d1);
		const store = new D1InstanceDisplayStore(d1);
		const sealed = await oldSealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		expect(
			(
				await instance.createInstanceInvitation(
					createCommand({
						sealedDisplayPayload: sealed.sealedPayload,
						displaySealingKeyId: sealed.sealingKeyId
					})
				)
			).outcome
		).toBe('created');
		expect(
			(
				await instance.acceptInstanceInvitation({
					actor: { type: 'user', id: TARGET_ID },
					idempotencyKey: 'accept-display-cas',
					requestFingerprint: 'b'.repeat(64),
					tokenHash: TOKEN_HASH,
					emailBinding: EMAIL_BINDING,
					acceptedAt: LATER_AT
				})
			).outcome
		).toBe('accepted');
		const revived = await rotated.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		expect(
			await store.casResealInvitationTarget({
				invitationId: INVITATION_ID,
				previousSealingKeyId: sealed.sealingKeyId,
				previousSealedPayload: sealed.sealedPayload,
				sealedPayload: revived.sealedPayload,
				sealingKeyId: revived.sealingKeyId,
				now: LATER_AT
			})
		).toBe('stale');
		expect(
			await store.deferInvitationReseal({
				invitationId: INVITATION_ID,
				previousSealingKeyId: sealed.sealingKeyId,
				previousSealedPayload: sealed.sealedPayload,
				now: LATER_AT
			})
		).toBe('stale');
		expect(
			sqlite.prepare('SELECT invitation_id FROM instance_invitation_display').all()
		).toHaveLength(0);
	});
});
