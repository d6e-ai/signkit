import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memberDisplayExpiresAt } from '$lib/domain/instance-display';
import { AesGcmInstanceDisplayPayloadSealer } from '$lib/security/instance-display-payload';
import type { CreateInstanceInvitationCommand } from '$lib/ports/instance-store';
import { PostgresInstanceDisplayStore } from './postgres-instance-display-store';
import { PostgresInstanceStore } from './postgres-instance-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED: boolean =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;

const OWNER_ID: string = 'owner-1';
const MEMBER_ID: string = 'member-1';
const TARGET_ID: string = 'target-1';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-09-19T12:00:00.000Z';
const OBSERVED_AT: string = '2026-09-12T12:00:00.000Z';
const LATER_AT: string = '2026-09-13T12:00:00.000Z';
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000401';
const TOKEN_HASH: string = 'c'.repeat(64);
const EMAIL_BINDING: string = 'e'.repeat(64);
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
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

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_display_${process.pid}_${randomUUID().replaceAll('-', '')}`;

function database(): ReturnType<typeof postgres> {
	if (sql === null) throw new Error('PostgreSQL connection not initialized');
	return sql;
}

postgresDescribe('PostgresInstanceDisplayStore integration', () => {
	beforeAll(async () => {
		sql = postgres(TEST_DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await database().unsafe(`CREATE SCHEMA "${schemaName}"`);
		await database().unsafe(`SET search_path TO "${schemaName}"`);
		await database().unsafe(`SET TIME ZONE 'UTC'`);
		for (const path of MIGRATION_PATHS) {
			await database().unsafe(readFileSync(path, 'utf8'));
		}
	});

	beforeEach(async () => {
		await database().unsafe(
			'TRUNCATE instance_member, instance_invitation, instance_invitation_command, instance_invitation_delivery_outbox CASCADE'
		);
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	async function insertMember(
		userId: string,
		role: 'owner' | 'admin' | 'member' = 'member',
		status: 'active' | 'suspended' = 'active'
	): Promise<void> {
		await database()`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${userId}, ${role}, ${status}, ${CREATED_AT}::timestamptz, ${CREATED_AT}::timestamptz)
		`;
	}

	it('records newer observations only for active members and authorizes bounded owner reads', async () => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(MEMBER_ID, 'member');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new PostgresInstanceDisplayStore(database());
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
		const listed = await store.listMemberDisplayRows({ type: 'user', id: OWNER_ID }, [
			OWNER_ID,
			'other-user'
		]);
		expect(listed.outcome).toBe('listed');
		if (listed.outcome !== 'listed') return;
		expect(listed.rows.map((row) => row.userId)).toEqual([OWNER_ID]);
		expect(await store.listMemberDisplayRows({ type: 'user', id: MEMBER_ID }, [OWNER_ID])).toEqual({
			outcome: 'forbidden'
		});
		expect(
			await store.deferMemberReseal({
				userId: OWNER_ID,
				previousSealingKeyId: sealed.sealingKeyId,
				previousObservedAt: OBSERVED_AT,
				previousExpiresAt: expiresAt,
				previousSealedPayload: sealed.sealedPayload,
				now: OBSERVED_AT
			})
		).toBe('deferred');
		const refreshed = await new AesGcmInstanceDisplayPayloadSealer(key(2)).sealMember(
			{
				name: 'Ada',
				email: 'ada@example.com',
				observedAt: LATER_AT,
				expiresAt: memberDisplayExpiresAt(LATER_AT)
			},
			OWNER_ID
		);
		expect(
			await store.recordMemberSnapshot({
				userId: OWNER_ID,
				...refreshed,
				observedAt: LATER_AT,
				expiresAt: memberDisplayExpiresAt(LATER_AT),
				storedAt: LATER_AT
			})
		).toEqual({ outcome: 'recorded' });
		const eligible = await store.findMemberRowsForReseal(refreshed.sealingKeyId, LATER_AT, 50);
		expect(eligible.map((row) => row.userId)).toEqual([OWNER_ID]);
	});

	it('atomically stores invitation display on create, scrubs on accept, and refuses replay recreation', async () => {
		await insertMember(OWNER_ID, 'owner');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const instance = new PostgresInstanceStore(database());
		const display = new PostgresInstanceDisplayStore(database());
		const sealed = await sealer.sealInvitationTarget(
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
		const pending = await display.listInvitationDisplayRows({ type: 'user', id: OWNER_ID }, [
			INVITATION_ID
		]);
		expect(pending.outcome).toBe('listed');
		if (pending.outcome !== 'listed') return;
		expect(pending.rows).toHaveLength(1);

		expect(
			(
				await instance.acceptInstanceInvitation({
					actor: { type: 'user', id: TARGET_ID },
					idempotencyKey: 'accept-display-1',
					requestFingerprint: 'b'.repeat(64),
					tokenHash: TOKEN_HASH,
					emailBinding: EMAIL_BINDING,
					acceptedAt: LATER_AT
				})
			).outcome
		).toBe('accepted');
		const afterAccept = await display.listInvitationDisplayRows({ type: 'user', id: OWNER_ID }, [
			INVITATION_ID
		]);
		expect(afterAccept.outcome).toBe('listed');
		if (afterAccept.outcome !== 'listed') return;
		expect(afterAccept.rows).toHaveLength(0);

		expect(
			(
				await instance.createInstanceInvitation(
					createCommand({
						sealedDisplayPayload: sealed.sealedPayload,
						displaySealingKeyId: sealed.sealingKeyId
					})
				)
			).outcome
		).toBe('replayed');
		const afterReplay = await display.listInvitationDisplayRows({ type: 'user', id: OWNER_ID }, [
			INVITATION_ID
		]);
		expect(afterReplay.outcome).toBe('listed');
		if (afterReplay.outcome !== 'listed') return;
		expect(afterReplay.rows).toHaveLength(0);
	});

	it('CAS reseal does not revive an updated snapshot', async () => {
		await insertMember(OWNER_ID, 'owner');
		const oldSealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const rotated = new AesGcmInstanceDisplayPayloadSealer(key(2), key(1));
		const store = new PostgresInstanceDisplayStore(database());
		const expiresAt: string = memberDisplayExpiresAt(OBSERVED_AT);
		const laterExpires: string = memberDisplayExpiresAt(LATER_AT);
		const first = await oldSealer.sealMember(
			{ name: 'Ada', email: 'ada@example.com', observedAt: OBSERVED_AT, expiresAt },
			OWNER_ID
		);
		await store.recordMemberSnapshot({
			userId: OWNER_ID,
			sealedPayload: first.sealedPayload,
			sealingKeyId: first.sealingKeyId,
			observedAt: OBSERVED_AT,
			expiresAt,
			storedAt: OBSERVED_AT
		});
		const second = await rotated.sealMember(
			{
				name: 'Ada Lovelace',
				email: 'ada@example.com',
				observedAt: LATER_AT,
				expiresAt: laterExpires
			},
			OWNER_ID
		);
		await store.recordMemberSnapshot({
			userId: OWNER_ID,
			sealedPayload: second.sealedPayload,
			sealingKeyId: second.sealingKeyId,
			observedAt: LATER_AT,
			expiresAt: laterExpires,
			storedAt: LATER_AT
		});
		const resealed = await rotated.sealMember(
			{ name: 'Ada', email: 'ada@example.com', observedAt: OBSERVED_AT, expiresAt },
			OWNER_ID
		);
		expect(
			await store.casResealMemberSnapshot({
				userId: OWNER_ID,
				previousSealingKeyId: first.sealingKeyId,
				previousObservedAt: OBSERVED_AT,
				previousExpiresAt: expiresAt,
				previousSealedPayload: first.sealedPayload,
				sealedPayload: resealed.sealedPayload,
				sealingKeyId: resealed.sealingKeyId,
				storedAt: LATER_AT
			})
		).toBe('stale');
	});

	it('shares one cleanup budget across members and invitations', async () => {
		await insertMember(OWNER_ID, 'owner');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new PostgresInstanceDisplayStore(database());
		const now: string = '2026-09-12T12:00:00.000Z';
		const expiredObserved: string = '2026-01-01T00:00:00.000Z';
		const expiredExpires: string = memberDisplayExpiresAt(expiredObserved);
		for (const userId of ['expired-a', 'expired-b', 'expired-c']) {
			await insertMember(userId);
			const sealed = await sealer.sealMember(
				{
					name: userId,
					email: `${userId}@example.com`,
					observedAt: expiredObserved,
					expiresAt: expiredExpires
				},
				userId
			);
			await database()`
				INSERT INTO instance_member_display (
					user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
				) VALUES (
					${userId}, ${sealed.sealedPayload}, ${sealed.sealingKeyId},
					${expiredObserved}::timestamptz, ${expiredExpires}::timestamptz,
					${expiredObserved}::timestamptz
				)
			`;
		}
		const invitationCreated: string = '2026-09-01T00:00:00.000Z';
		const invitationExpired: string = '2026-09-08T00:00:00.000Z';
		for (let index = 0; index < 3; index += 1) {
			const invitationId: string = `01900000-0000-7000-8a00-${(index + 1).toString(16).padStart(12, '0')}`;
			const tokenHash: string = (index + 1).toString(16).padStart(64, 'a');
			const sealed = await sealer.sealInvitationTarget({ email: 'old@example.com' }, invitationId);
			await database()`
				INSERT INTO instance_invitation (
					id, role, status, token_hash, email_binding, invited_by_user_id,
					created_at, expires_at
				) VALUES (
					${invitationId}, 'member', 'pending', ${tokenHash}, ${tokenHash},
					${OWNER_ID}, ${invitationCreated}::timestamptz, ${invitationExpired}::timestamptz
				)
			`;
			await database()`
				INSERT INTO instance_invitation_display (
					invitation_id, sealed_payload, sealing_key_id, created_at, expires_at
				) VALUES (
					${invitationId}, ${sealed.sealedPayload}, ${sealed.sealingKeyId},
					${invitationCreated}::timestamptz, ${invitationExpired}::timestamptz
				)
			`;
		}
		expect(await store.cleanupExpired(now, 0)).toEqual({ expired: 0, deleted: 0 });
		expect(await store.cleanupExpired(now, 4)).toEqual({ expired: 3, deleted: 1 });
		const [{ remaining }]: { remaining: number }[] = await database()`
			SELECT count(*)::int AS remaining FROM instance_invitation_display
		`;
		expect(remaining).toBe(2);
	});

	it('does not delete a concurrently refreshed snapshot while cleaning other expired rows', async () => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(MEMBER_ID, 'member');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const now: string = '2026-09-12T12:00:00.000Z';
		const expiredObserved: string = '2026-01-01T00:00:00.000Z';
		const expiredExpires: string = memberDisplayExpiresAt(expiredObserved);
		const laterExpires: string = memberDisplayExpiresAt(LATER_AT);
		for (const userId of [OWNER_ID, MEMBER_ID]) {
			const sealed = await sealer.sealMember(
				{
					name: userId,
					email: `${userId}@example.com`,
					observedAt: expiredObserved,
					expiresAt: expiredExpires
				},
				userId
			);
			await database()`
				INSERT INTO instance_member_display (
					user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
				) VALUES (
					${userId}, ${sealed.sealedPayload}, ${sealed.sealingKeyId},
					${expiredObserved}::timestamptz, ${expiredExpires}::timestamptz,
					${expiredObserved}::timestamptz
				)
			`;
		}
		const refreshed = await sealer.sealMember(
			{
				name: 'Ada Lovelace',
				email: 'ada@example.com',
				observedAt: LATER_AT,
				expiresAt: laterExpires
			},
			OWNER_ID
		);
		const cleanerName: string = `${schemaName.slice(0, 60)}_c`;
		const blocker = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined
		});
		const cleanerSql = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			connection: { application_name: cleanerName },
			onnotice: (): void => undefined
		});
		const observer = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined
		});
		try {
			await blocker.unsafe(`SET search_path TO "${schemaName}"`);
			await cleanerSql.unsafe(`SET search_path TO "${schemaName}"`);
			const cleanerStore = new PostgresInstanceDisplayStore(cleanerSql);
			let cleanupPromise: Promise<{ expired: number; deleted: number }> | undefined;
			await blocker.begin(async (transaction) => {
				await transaction`
					UPDATE instance_member_display
					SET sealed_payload = ${refreshed.sealedPayload},
						sealing_key_id = ${refreshed.sealingKeyId},
						observed_at = ${LATER_AT}::timestamptz,
						expires_at = ${laterExpires}::timestamptz,
						stored_at = ${LATER_AT}::timestamptz
					WHERE user_id = ${OWNER_ID}
				`;
				cleanupPromise = cleanerStore.cleanupExpired(now, 100);
				const deadline: number = Date.now() + 8000;
				let waiting = false;
				while (Date.now() < deadline) {
					const waits = await observer<{ waitEventType: string | null }[]>`
						SELECT wait_event_type AS "waitEventType"
						FROM pg_stat_activity
						WHERE application_name = ${cleanerName} AND wait_event_type = 'Lock'
					`;
					if (waits.length > 0) {
						waiting = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				expect(waiting).toBe(true);
			});
			expect(cleanupPromise).toBeDefined();
			expect(await cleanupPromise).toEqual({ expired: 1, deleted: 0 });
			const leftoverRows: { userId: string }[] = await database()`
				SELECT user_id AS "userId" FROM instance_member_display ORDER BY user_id
			`;
			expect(leftoverRows.map((row) => row.userId)).toEqual([OWNER_ID]);
			const liveRows: { expiresAt: Date }[] = await database()`
				SELECT expires_at AS "expiresAt" FROM instance_member_display WHERE user_id = ${OWNER_ID}
			`;
			expect(liveRows[0]?.expiresAt.toISOString()).toBe(laterExpires);
		} finally {
			await blocker.end({ timeout: 5 });
			await cleanerSql.end({ timeout: 5 });
			await observer.end({ timeout: 5 });
		}
	});

	it('holds FOR SHARE across the display page read so a concurrent demotion is visible', async () => {
		await insertMember(OWNER_ID, 'owner');
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const store = new PostgresInstanceDisplayStore(database());
		const expiresAt: string = memberDisplayExpiresAt(OBSERVED_AT);
		const sealed = await sealer.sealMember(
			{ name: 'Ada', email: 'ada@example.com', observedAt: OBSERVED_AT, expiresAt },
			OWNER_ID
		);
		await store.recordMemberSnapshot({
			userId: OWNER_ID,
			sealedPayload: sealed.sealedPayload,
			sealingKeyId: sealed.sealingKeyId,
			observedAt: OBSERVED_AT,
			expiresAt,
			storedAt: OBSERVED_AT
		});
		const listerName: string = `${schemaName.slice(0, 60)}_l`;
		const blocker = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined
		});
		const listerSql = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			connection: { application_name: listerName },
			onnotice: (): void => undefined
		});
		const observer = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined
		});
		try {
			await blocker.unsafe(`SET search_path TO "${schemaName}"`);
			await listerSql.unsafe(`SET search_path TO "${schemaName}"`);
			const listerStore = new PostgresInstanceDisplayStore(listerSql);
			let listed: Promise<unknown> | undefined;
			await blocker.begin(async (transaction) => {
				await transaction`
					SELECT role, status FROM instance_member WHERE user_id = ${OWNER_ID} FOR UPDATE
				`;
				listed = listerStore.listMemberDisplayRows({ type: 'user', id: OWNER_ID }, [OWNER_ID]);
				const deadline: number = Date.now() + 8000;
				let waiting = false;
				while (Date.now() < deadline) {
					const waits = await observer<{ waitEventType: string | null }[]>`
						SELECT wait_event_type AS "waitEventType"
						FROM pg_stat_activity
						WHERE application_name = ${listerName} AND wait_event_type = 'Lock'
					`;
					if (waits.length > 0) {
						waiting = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				expect(waiting).toBe(true);
				await transaction`
					UPDATE instance_member SET status = 'suspended' WHERE user_id = ${OWNER_ID}
				`;
			});
			expect(await listed).toEqual({ outcome: 'member_suspended' });
		} finally {
			await blocker.end({ timeout: 5 });
			await listerSql.end({ timeout: 5 });
			await observer.end({ timeout: 5 });
		}
	});
});
