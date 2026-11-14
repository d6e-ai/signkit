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
				sealedPayload: resealed.sealedPayload,
				sealingKeyId: resealed.sealingKeyId,
				storedAt: LATER_AT
			})
		).toBe('stale');
	});
});
