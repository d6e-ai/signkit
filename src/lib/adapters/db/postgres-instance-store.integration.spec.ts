import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
	AcceptInstanceInvitationCommand,
	AcceptInstanceInvitationStoreResult,
	BootstrapInstanceCommand,
	BootstrapInstanceStoreResult,
	CreateInstanceInvitationCommand,
	CreateInstanceInvitationStoreResult,
	InstanceInvitationListPage,
	InstanceInvitationListQuery,
	InstanceInvitationMetadata,
	InstanceMemberListPage,
	InstanceMemberListQuery,
	InstanceMemberRole,
	InstanceMemberStatus,
	InstanceStore,
	ListInstanceInvitationsStoreResult,
	ListInstanceMembersStoreResult,
	RevokeInstanceInvitationCommand,
	RevokeInstanceInvitationStoreResult,
	SetInstanceMemberRoleCommand,
	SetInstanceMemberRoleStoreResult,
	SetInstanceMemberStatusCommand,
	SetInstanceMemberStatusStoreResult
} from '$lib/ports/instance-store';
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

const ACTOR_ID: string = 'user-owner-1';
const OTHER_ACTOR_ID: string = 'user-other-2';
const OWNER_ID: string = 'user-owner-1';
const OWNER2_ID: string = 'user-owner-2';
const ADMIN_ID: string = 'user-admin-1';
const MEMBER_ID: string = 'user-member-1';
const TARGET_ID: string = 'user-target-1';
const ACCEPTOR_ID: string = 'user-acceptor-1';
const SUSPENDED_USER_ID: string = 'user-suspended-1';
const SUSPENDED_ADMIN_ID: string = 'admin-suspended-1';

const IDEMPOTENCY_KEY: string = 'bootstrap-idem-key-1';
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);
const OTHER_REQUEST_FINGERPRINT: string = 'b'.repeat(64);

const INVITATION_ID: string = '01900000-0000-7000-8000-000000000001';
const OTHER_INVITATION_ID: string = '01900000-0000-7000-8000-000000000002';
const TOKEN_HASH: string = '1'.repeat(64);
const OTHER_TOKEN_HASH: string = '2'.repeat(64);
const EMAIL_BINDING: string = '3'.repeat(64);

const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-09-19T12:00:00.000Z';
const ACCEPTED_AT: string = '2026-09-13T12:00:00.000Z';
const REVOKED_AT: string = '2026-09-13T12:00:00.000Z';
const UPDATED_AT: string = '2026-09-13T13:00:00.000Z';
const LATER_AT: string = '2026-09-14T13:00:00.000Z';

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

function bootstrapCommand(
	overrides: Partial<BootstrapInstanceCommand> = {}
): BootstrapInstanceCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: IDEMPOTENCY_KEY,
		requestFingerprint: REQUEST_FINGERPRINT,
		createdAt: CREATED_AT,
		...overrides
	};
}

function createCommand(
	overrides: Partial<CreateInstanceInvitationCommand> = {}
): CreateInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'create-idem-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		invitationId: INVITATION_ID,
		role: 'member',
		tokenHash: TOKEN_HASH,
		emailBinding: EMAIL_BINDING,
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
		...overrides
	};
}

function acceptCommand(
	overrides: Partial<AcceptInstanceInvitationCommand> = {}
): AcceptInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: ACCEPTOR_ID },
		idempotencyKey: 'accept-idem-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		tokenHash: TOKEN_HASH,
		emailBinding: EMAIL_BINDING,
		acceptedAt: ACCEPTED_AT,
		...overrides
	};
}

function revokeCommand(
	overrides: Partial<RevokeInstanceInvitationCommand> = {}
): RevokeInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'revoke-idem-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		invitationId: INVITATION_ID,
		revokedAt: REVOKED_AT,
		...overrides
	};
}

function listQuery(
	overrides: Partial<InstanceInvitationListQuery> = {}
): InstanceInvitationListQuery {
	return {
		cursor: null,
		limit: 25,
		...overrides
	};
}

function memberListQuery(
	overrides: Partial<InstanceMemberListQuery> = {}
): InstanceMemberListQuery {
	return {
		cursor: null,
		limit: 25,
		...overrides
	};
}

function setRoleCommand(
	overrides: Partial<SetInstanceMemberRoleCommand> = {}
): SetInstanceMemberRoleCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'role-idem-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		targetUserId: TARGET_ID,
		role: 'admin',
		updatedAt: UPDATED_AT,
		...overrides
	};
}

function setStatusCommand(
	overrides: Partial<SetInstanceMemberStatusCommand> = {}
): SetInstanceMemberStatusCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'status-idem-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		targetUserId: TARGET_ID,
		status: 'suspended',
		updatedAt: UPDATED_AT,
		...overrides
	};
}

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_instance_${process.pid}_${randomUUID().replaceAll('-', '')}`;

function database(): ReturnType<typeof postgres> {
	if (sql === null) throw new Error('PostgreSQL connection not initialized');
	return sql;
}

postgresDescribe('PostgresInstanceStore integration', () => {
	beforeAll(async () => {
		const databaseUrl: string = TEST_DATABASE_URL as string;
		sql = postgres(databaseUrl, { max: 1, onnotice: (): void => undefined });
		await database().unsafe(`CREATE SCHEMA "${schemaName}"`);
		await database().unsafe(`SET search_path TO "${schemaName}"`);
		await database().unsafe(`SET TIME ZONE 'UTC'`);
		for (const path of MIGRATION_PATHS) {
			await database().unsafe(readFileSync(path, 'utf8'));
		}
	});

	beforeEach(async () => {
		await database().unsafe('TRUNCATE instance_member CASCADE');
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	function store(): PostgresInstanceStore {
		return new PostgresInstanceStore(database());
	}

	async function memberRows(): Promise<{ userId: string; role: string }[]> {
		return database()<
			{ userId: string; role: string }[]
		>`SELECT user_id AS "userId", role FROM instance_member`;
	}

	async function insertMember(
		userId: string,
		role: InstanceMemberRole,
		status: InstanceMemberStatus = 'active',
		createdAt: string = CREATED_AT
	): Promise<void> {
		await database()`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${userId}, ${role}, ${status}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
		`;
	}

	async function seedPendingInvitations(
		count: number,
		inviterUserId: string,
		createdAt: string = CREATED_AT,
		expiresAt: string = EXPIRES_AT
	): Promise<void> {
		await database()`
			INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id,
				created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
			)
			SELECT
				'01900000-0000-7000-8000-' || lpad(i::text, 12, '0'),
				'member',
				'pending',
				lpad(i::text, 64, '0'),
				lpad(i::text, 64, 'a'),
				${inviterUserId},
				${createdAt}::timestamptz,
				${expiresAt}::timestamptz,
				NULL, NULL, NULL, NULL
			FROM generate_series(1, ${count}) AS s(i)
		`;
	}

	it('claims the initial owner slot on an empty instance', async () => {
		const result: BootstrapInstanceStoreResult =
			await store().bootstrapInstance(bootstrapCommand());
		expect(result).toEqual({
			outcome: 'bootstrapped',
			member: {
				userId: ACTOR_ID,
				role: 'owner',
				status: 'active',
				createdAt: new Date(CREATED_AT).toISOString(),
				updatedAt: new Date(CREATED_AT).toISOString()
			}
		});

		const members = await memberRows();
		expect(members).toEqual([{ userId: ACTOR_ID, role: 'owner' }]);

		const bootstrapRows = await database()<
			{ ownerUserId: string }[]
		>`SELECT owner_user_id AS "ownerUserId" FROM instance_bootstrap`;
		expect(bootstrapRows).toEqual([{ ownerUserId: ACTOR_ID }]);
	});

	it('leaves exactly one owner and no orphan member under concurrent different-subject bootstrap', async () => {
		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly InstanceStore[] = synchronizeBootstrap([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const [first, second]: BootstrapInstanceStoreResult[] = await Promise.all([
				storeA.bootstrapInstance(bootstrapCommand({ actor: { type: 'user', id: ACTOR_ID } })),
				storeB.bootstrapInstance(
					bootstrapCommand({
						actor: { type: 'user', id: OTHER_ACTOR_ID },
						idempotencyKey: 'other-idem-key',
						requestFingerprint: OTHER_REQUEST_FINGERPRINT
					})
				)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['already_bootstrapped', 'bootstrapped']);

			const members = await memberRows();
			expect(members).toHaveLength(1);
			expect(members[0]?.role).toBe('owner');

			const bootstrapRows = await database()<
				{ ownerUserId: string }[]
			>`SELECT owner_user_id AS "ownerUserId" FROM instance_bootstrap`;
			expect(bootstrapRows).toHaveLength(1);
			expect(bootstrapRows[0]?.ownerUserId).toBe(members[0]?.userId);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('resolves a genuinely concurrent same-actor, same-idempotency-key bootstrap race to one bootstrap and one replay', async () => {
		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly InstanceStore[] = synchronizeBootstrap([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const command: BootstrapInstanceCommand = bootstrapCommand();
			const [first, second]: BootstrapInstanceStoreResult[] = await Promise.all([
				storeA.bootstrapInstance(command),
				storeB.bootstrapInstance(command)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['already_bootstrapped', 'bootstrapped']);

			const bootstrapped: Extract<BootstrapInstanceStoreResult, { outcome: 'bootstrapped' }> = (
				first.outcome === 'bootstrapped' ? first : second
			) as Extract<BootstrapInstanceStoreResult, { outcome: 'bootstrapped' }>;
			const replay: Extract<
				BootstrapInstanceStoreResult,
				{ outcome: 'already_bootstrapped'; replayed: true }
			> = (first.outcome === 'already_bootstrapped' ? first : second) as Extract<
				BootstrapInstanceStoreResult,
				{ outcome: 'already_bootstrapped'; replayed: true }
			>;
			expect(replay.replayed).toBe(true);
			expect(replay.member).toEqual(bootstrapped.member);
			expect(bootstrapped.member).toEqual({
				userId: ACTOR_ID,
				role: 'owner',
				status: 'active',
				createdAt: new Date(CREATED_AT).toISOString(),
				updatedAt: new Date(CREATED_AT).toISOString()
			});

			const members = await memberRows();
			expect(members).toEqual([{ userId: ACTOR_ID, role: 'owner' }]);

			const bootstrapRows = await database()<
				{ ownerUserId: string }[]
			>`SELECT owner_user_id AS "ownerUserId" FROM instance_bootstrap`;
			expect(bootstrapRows).toEqual([{ ownerUserId: ACTOR_ID }]);

			const commandRows = await database()<
				{ actorId: string }[]
			>`SELECT actor_id AS "actorId" FROM instance_bootstrap_command`;
			expect(commandRows).toEqual([{ actorId: ACTOR_ID }]);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('refuses bootstrap when a member already exists', async () => {
		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('preexisting-user', 'member', 'active', ${CREATED_AT}::timestamptz, ${CREATED_AT}::timestamptz)`;

		const result: BootstrapInstanceStoreResult =
			await store().bootstrapInstance(bootstrapCommand());
		expect(result).toEqual({ outcome: 'already_bootstrapped', replayed: false });

		const members = await memberRows();
		expect(members).toEqual([{ userId: 'preexisting-user', role: 'member' }]);
	});

	it('replays an exact request safely under the original idempotency key', async () => {
		await store().bootstrapInstance(bootstrapCommand());

		const replay: BootstrapInstanceStoreResult =
			await store().bootstrapInstance(bootstrapCommand());
		expect(replay).toEqual({
			outcome: 'already_bootstrapped',
			member: {
				userId: ACTOR_ID,
				role: 'owner',
				status: 'active',
				createdAt: new Date(CREATED_AT).toISOString(),
				updatedAt: new Date(CREATED_AT).toISOString()
			},
			replayed: true
		});

		const members = await memberRows();
		expect(members).toHaveLength(1);
	});

	it('rejects a reused idempotency key with a conflicting request fingerprint', async () => {
		await store().bootstrapInstance(bootstrapCommand());

		const conflict: BootstrapInstanceStoreResult = await store().bootstrapInstance(
			bootstrapCommand({ requestFingerprint: OTHER_REQUEST_FINGERPRINT })
		);
		expect(conflict).toEqual({ outcome: 'idempotency_conflict' });

		const members = await memberRows();
		expect(members).toHaveLength(1);
	});

	it('detects a corrupted owner receipt as integrity_error on replay', async () => {
		await store().bootstrapInstance(bootstrapCommand());

		await database()`UPDATE instance_member SET status = 'suspended' WHERE user_id = ${ACTOR_ID}`;

		const replay: BootstrapInstanceStoreResult =
			await store().bootstrapInstance(bootstrapCommand());
		expect(replay).toEqual({ outcome: 'integrity_error' });
	});

	it('enforces owner and admin create permissions and role ceilings', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(ADMIN_ID, 'admin');
		await insertMember(MEMBER_ID, 'member');

		// Owner can create member, admin, and owner invitations
		const ownerInvitesMember: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: OWNER_ID },
					idempotencyKey: 'owner-create-member',
					invitationId: '01900000-0000-7000-8000-000000000001',
					role: 'member',
					tokenHash: '1'.repeat(64)
				})
			);
		expect(ownerInvitesMember).toEqual({
			outcome: 'created',
			invitation: expect.objectContaining({
				id: '01900000-0000-7000-8000-000000000001',
				role: 'member',
				status: 'pending',
				invitedByUserId: OWNER_ID
			})
		});

		const ownerInvitesAdmin: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: OWNER_ID },
					idempotencyKey: 'owner-create-admin',
					invitationId: '01900000-0000-7000-8000-000000000002',
					role: 'admin',
					tokenHash: '2'.repeat(64)
				})
			);
		expect(ownerInvitesAdmin).toEqual({
			outcome: 'created',
			invitation: expect.objectContaining({
				id: '01900000-0000-7000-8000-000000000002',
				role: 'admin',
				status: 'pending',
				invitedByUserId: OWNER_ID
			})
		});

		const ownerInvitesOwner: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: OWNER_ID },
					idempotencyKey: 'owner-create-owner',
					invitationId: '01900000-0000-7000-8000-000000000003',
					role: 'owner',
					tokenHash: '3'.repeat(64)
				})
			);
		expect(ownerInvitesOwner).toEqual({
			outcome: 'created',
			invitation: expect.objectContaining({
				id: '01900000-0000-7000-8000-000000000003',
				role: 'owner',
				status: 'pending',
				invitedByUserId: OWNER_ID
			})
		});

		// Admin can create member invitations
		const adminInvitesMember: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: ADMIN_ID },
					idempotencyKey: 'admin-create-member',
					invitationId: '01900000-0000-7000-8000-000000000004',
					role: 'member',
					tokenHash: '4'.repeat(64)
				})
			);
		expect(adminInvitesMember).toEqual({
			outcome: 'created',
			invitation: expect.objectContaining({
				id: '01900000-0000-7000-8000-000000000004',
				role: 'member',
				status: 'pending',
				invitedByUserId: ADMIN_ID
			})
		});

		// Admin cannot create admin or owner invitations (role ceiling)
		const adminInvitesAdmin: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: ADMIN_ID },
					idempotencyKey: 'admin-create-admin',
					invitationId: '01900000-0000-7000-8000-000000000005',
					role: 'admin',
					tokenHash: '5'.repeat(64)
				})
			);
		expect(adminInvitesAdmin).toEqual({ outcome: 'role_not_permitted' });

		const adminInvitesOwner: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: ADMIN_ID },
					idempotencyKey: 'admin-create-owner',
					invitationId: '01900000-0000-7000-8000-000000000006',
					role: 'owner',
					tokenHash: '6'.repeat(64)
				})
			);
		expect(adminInvitesOwner).toEqual({ outcome: 'role_not_permitted' });

		// Regular member cannot create invitations
		const memberInvitesMember: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: MEMBER_ID },
					idempotencyKey: 'member-create-member',
					invitationId: '01900000-0000-7000-8000-000000000007',
					role: 'member',
					tokenHash: '7'.repeat(64)
				})
			);
		expect(memberInvitesMember).toEqual({ outcome: 'forbidden' });

		// Non-member caller cannot create invitations
		const strangerInvites: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(
				createCommand({
					actor: { type: 'user', id: 'user-stranger' },
					idempotencyKey: 'stranger-create',
					invitationId: '01900000-0000-7000-8000-000000000008',
					role: 'member',
					tokenHash: '8'.repeat(64)
				})
			);
		expect(strangerInvites).toEqual({ outcome: 'forbidden' });

		const persistedRows: { id: string; role: string }[] = await database()<
			{ id: string; role: string }[]
		>`SELECT id, role FROM instance_invitation ORDER BY id`;
		expect(persistedRows).toHaveLength(4);
	});

	it('returns original metadata on realistic create replay with reminted candidate parameters', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');

		const originalCommand: CreateInstanceInvitationCommand = createCommand({
			actor: { type: 'user', id: OWNER_ID },
			idempotencyKey: 'create-replay-test-key',
			requestFingerprint: REQUEST_FINGERPRINT,
			invitationId: '01900000-0000-7000-8000-000000000001',
			role: 'member',
			tokenHash: '1'.repeat(64),
			emailBinding: '2'.repeat(64),
			createdAt: '2026-09-12T12:00:00.000Z',
			expiresAt: '2026-09-19T12:00:00.000Z'
		});
		const createdResult: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(originalCommand);
		expect(createdResult.outcome).toBe('created');
		const originalInvitation: InstanceInvitationMetadata = (
			createdResult as Extract<CreateInstanceInvitationStoreResult, { outcome: 'created' }>
		).invitation;

		// Reminted candidate parameters: same actor, same key, same fingerprint, same role,
		// but new candidate invitationId, tokenHash, emailBinding, createdAt, expiresAt
		const remintedCommand: CreateInstanceInvitationCommand = createCommand({
			actor: { type: 'user', id: OWNER_ID },
			idempotencyKey: 'create-replay-test-key',
			requestFingerprint: REQUEST_FINGERPRINT,
			role: 'member',
			invitationId: '01900000-0000-7000-8000-000000000099',
			tokenHash: '9'.repeat(64),
			emailBinding: 'a'.repeat(64),
			createdAt: '2026-09-12T13:00:00.000Z',
			expiresAt: '2026-09-19T13:00:00.000Z'
		});
		const replayResult: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(remintedCommand);

		expect(replayResult).toEqual({
			outcome: 'replayed',
			invitation: originalInvitation
		});
		const replayedInvitation: InstanceInvitationMetadata = (
			replayResult as Extract<CreateInstanceInvitationStoreResult, { outcome: 'replayed' }>
		).invitation;
		expect(replayedInvitation.id).toBe('01900000-0000-7000-8000-000000000001');
		expect(replayedInvitation.createdAt).toBe('2026-09-12T12:00:00.000Z');
		expect(replayedInvitation.expiresAt).toBe('2026-09-19T12:00:00.000Z');

		const invitationRows: { id: string; tokenHash: string }[] = await database()<
			{ id: string; tokenHash: string }[]
		>`SELECT id, token_hash AS "tokenHash" FROM instance_invitation`;
		expect(invitationRows).toEqual([
			{ id: '01900000-0000-7000-8000-000000000001', tokenHash: '1'.repeat(64) }
		]);

		const commandRows: { invitationId: string; requestHash: string }[] = await database()<
			{ invitationId: string; requestHash: string }[]
		>`SELECT invitation_id AS "invitationId", request_hash AS "requestHash" FROM instance_invitation_command`;
		expect(commandRows).toEqual([
			{
				invitationId: '01900000-0000-7000-8000-000000000001',
				requestHash: REQUEST_FINGERPRINT
			}
		]);
	});

	it('classifies a candidate invitationId collision as credential_collision when no matching receipt exists', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');

		const initialCommand: CreateInstanceInvitationCommand = createCommand();
		const initial: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(initialCommand);
		expect(initial.outcome).toBe('created');

		const collisionCommand: CreateInstanceInvitationCommand = createCommand({
			idempotencyKey: 'invite-create-key-2',
			requestFingerprint: OTHER_REQUEST_FINGERPRINT,
			tokenHash: OTHER_TOKEN_HASH,
			emailBinding: 'f'.repeat(64)
		});
		const result: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(collisionCommand);

		expect(result).toEqual({ outcome: 'credential_collision' });
	});

	it('classifies a candidate tokenHash collision as credential_collision when no matching receipt exists', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');

		const initialCommand: CreateInstanceInvitationCommand = createCommand();
		const initial: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(initialCommand);
		expect(initial.outcome).toBe('created');

		const collisionCommand: CreateInstanceInvitationCommand = createCommand({
			idempotencyKey: 'invite-create-key-2',
			requestFingerprint: OTHER_REQUEST_FINGERPRINT,
			invitationId: OTHER_INVITATION_ID,
			emailBinding: 'f'.repeat(64)
		});
		const result: CreateInstanceInvitationStoreResult =
			await store().createInstanceInvitation(collisionCommand);

		expect(result).toEqual({ outcome: 'credential_collision' });
	});

	it('resolves real max>=2 synchronized same-key concurrent create to created+replayed and one row', async (): Promise<void> => {
		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			await insertMember(OWNER_ID, 'owner');
			const [storeA, storeB]: readonly SynchronizedCreateStore[] = synchronizeCreate([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const command: CreateInstanceInvitationCommand = createCommand();
			const [first, second]: CreateInstanceInvitationStoreResult[] = await Promise.all([
				storeA.createInstanceInvitation(command),
				storeB.createInstanceInvitation(command)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['created', 'replayed']);

			const created: Extract<CreateInstanceInvitationStoreResult, { outcome: 'created' }> = (
				first.outcome === 'created' ? first : second
			) as Extract<CreateInstanceInvitationStoreResult, { outcome: 'created' }>;
			const replayed: Extract<CreateInstanceInvitationStoreResult, { outcome: 'replayed' }> = (
				first.outcome === 'replayed' ? first : second
			) as Extract<CreateInstanceInvitationStoreResult, { outcome: 'replayed' }>;

			expect(replayed.invitation).toEqual(created.invitation);

			const invitationRows: { id: string }[] = await database()<
				{ id: string }[]
			>`SELECT id FROM instance_invitation`;
			expect(invitationRows).toHaveLength(1);
			expect(invitationRows[0]?.id).toBe(command.invitationId);

			const commandRows: { invitationId: string }[] = await database()<
				{ invitationId: string }[]
			>`SELECT invitation_id AS "invitationId" FROM instance_invitation_command`;
			expect(commandRows).toHaveLength(1);
			expect(commandRows[0]?.invitationId).toBe(command.invitationId);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('seeds 199 pending invitations then concurrent creates give created+limit and exactly 200 rows', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await seedPendingInvitations(199, OWNER_ID);

		const initialCount: { count: string | number }[] = await database()<
			{ count: string | number }[]
		>`SELECT count(*)::int AS count FROM instance_invitation WHERE status = 'pending'`;
		expect(Number(initialCount[0]?.count)).toBe(199);

		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly SynchronizedCreateStore[] = synchronizeCreate([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const cmd1: CreateInstanceInvitationCommand = createCommand({
				idempotencyKey: 'race-cap-create-1',
				invitationId: '01900000-0000-7000-8000-000000001001',
				tokenHash: 'b'.repeat(64),
				emailBinding: 'c'.repeat(64)
			});
			const cmd2: CreateInstanceInvitationCommand = createCommand({
				idempotencyKey: 'race-cap-create-2',
				invitationId: '01900000-0000-7000-8000-000000001002',
				tokenHash: 'd'.repeat(64),
				emailBinding: 'e'.repeat(64)
			});

			const [first, second]: CreateInstanceInvitationStoreResult[] = await Promise.all([
				storeA.createInstanceInvitation(cmd1),
				storeB.createInstanceInvitation(cmd2)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['created', 'limit']);

			const totalCountRows: { count: string | number }[] = await database()<
				{ count: string | number }[]
			>`SELECT count(*)::int AS count FROM instance_invitation`;
			expect(Number(totalCountRows[0]?.count)).toBe(200);

			const pendingCountRows: { count: string | number }[] = await database()<
				{ count: string | number }[]
			>`SELECT count(*)::int AS count FROM instance_invitation WHERE status = 'pending'`;
			expect(Number(pendingCountRows[0]?.count)).toBe(200);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('proves 200 expired pending invitations do not block a new create, while 200 live pending still returns limit', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');

		// Seed 200 expired pending invitations
		const expiredCreatedAt: string = '2026-09-01T12:00:00.000Z';
		const expiredExpiresAt: string = '2026-09-08T12:00:00.000Z';
		await seedPendingInvitations(200, OWNER_ID, expiredCreatedAt, expiredExpiresAt);

		// New create with createdAt = CREATED_AT (2026-09-12T12:00:00.000Z) strictly after expiredExpiresAt:
		// 200 expired pending invitations do not block create.
		const allowed = await store().createInstanceInvitation(
			createCommand({
				idempotencyKey: 'allowed-after-expired',
				invitationId: '01900000-0000-7000-8000-000000000998',
				tokenHash: '8'.repeat(64),
				emailBinding: '8'.repeat(64)
			})
		);
		expect(allowed.outcome).toBe('created');

		// Truncate and seed 200 live pending invitations (live relative to CREATED_AT)
		await database().unsafe('TRUNCATE instance_invitation CASCADE');
		await seedPendingInvitations(200, OWNER_ID, CREATED_AT, EXPIRES_AT);

		// New create fails with limit because 200 live pending invitations exist
		const limited = await store().createInstanceInvitation(
			createCommand({
				idempotencyKey: 'limited-by-live-pending',
				invitationId: '01900000-0000-7000-8000-000000000999',
				tokenHash: '9'.repeat(64),
				emailBinding: '9'.repeat(64)
			})
		);
		expect(limited).toEqual({ outcome: 'limit' });
	});

	it('lists invitations with safe zero-PII metadata, correct pagination, and no hash disclosure', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(ADMIN_ID, 'admin');
		await insertMember(MEMBER_ID, 'member');

		const timestamps: readonly string[] = [
			'2026-09-12T10:00:00.000Z',
			'2026-09-12T11:00:00.000Z',
			'2026-09-12T12:00:00.000Z',
			'2026-09-12T13:00:00.000Z',
			'2026-09-12T14:00:00.000Z'
		];
		for (let i = 0; i < 5; i++) {
			await database()`
				INSERT INTO instance_invitation (
					id, role, status, token_hash, email_binding, invited_by_user_id,
					created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
				) VALUES (
					${`01900000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`},
					'member',
					'pending',
					${String(i).repeat(64).slice(0, 64)},
					${String(i).repeat(64).slice(0, 64)},
					${OWNER_ID},
					${timestamps[i]}::timestamptz,
					(${timestamps[i]}::timestamptz + INTERVAL '7 days'),
					NULL, NULL, NULL, NULL
				)
			`;
		}

		// 1. Safe metadata and no hashes
		const fullListResult: ListInstanceInvitationsStoreResult =
			await store().listInstanceInvitations(
				{ type: 'user', id: OWNER_ID },
				{ cursor: null, limit: 10 }
			);
		expect(fullListResult.outcome).toBe('listed');
		const fullPage: InstanceInvitationListPage = (
			fullListResult as Extract<ListInstanceInvitationsStoreResult, { outcome: 'listed' }>
		).page;
		expect(fullPage.items).toHaveLength(5);

		for (const item of fullPage.items) {
			expect(Object.keys(item).sort()).toEqual([
				'acceptedAt',
				'acceptedByUserId',
				'createdAt',
				'expiresAt',
				'id',
				'invitedByUserId',
				'revokedAt',
				'revokedByUserId',
				'role',
				'status'
			]);
			const itemRecord: Record<string, unknown> = item as unknown as Record<string, unknown>;
			expect(itemRecord.tokenHash).toBeUndefined();
			expect(itemRecord.token_hash).toBeUndefined();
			expect(itemRecord.emailBinding).toBeUndefined();
			expect(itemRecord.email_binding).toBeUndefined();
			expect(itemRecord.token).toBeUndefined();
			expect(itemRecord.email).toBeUndefined();
		}

		// 2. Pagination: 2 items per page
		const page1Result: ListInstanceInvitationsStoreResult = await store().listInstanceInvitations(
			{ type: 'user', id: OWNER_ID },
			{ cursor: null, limit: 2 }
		);
		expect(page1Result.outcome).toBe('listed');
		const page1: InstanceInvitationListPage = (
			page1Result as Extract<ListInstanceInvitationsStoreResult, { outcome: 'listed' }>
		).page;
		expect(page1.items).toHaveLength(2);
		expect(page1.items[0]?.id).toBe('01900000-0000-7000-8000-000000000005');
		expect(page1.items[1]?.id).toBe('01900000-0000-7000-8000-000000000004');
		expect(page1.nextCursor).toBe('01900000-0000-7000-8000-000000000004');

		const page2Result: ListInstanceInvitationsStoreResult = await store().listInstanceInvitations(
			{ type: 'user', id: OWNER_ID },
			{ cursor: page1.nextCursor, limit: 2 }
		);
		expect(page2Result.outcome).toBe('listed');
		const page2: InstanceInvitationListPage = (
			page2Result as Extract<ListInstanceInvitationsStoreResult, { outcome: 'listed' }>
		).page;
		expect(page2.items).toHaveLength(2);
		expect(page2.items[0]?.id).toBe('01900000-0000-7000-8000-000000000003');
		expect(page2.items[1]?.id).toBe('01900000-0000-7000-8000-000000000002');
		expect(page2.nextCursor).toBe('01900000-0000-7000-8000-000000000002');

		const page3Result: ListInstanceInvitationsStoreResult = await store().listInstanceInvitations(
			{ type: 'user', id: OWNER_ID },
			{ cursor: page2.nextCursor, limit: 2 }
		);
		expect(page3Result.outcome).toBe('listed');
		const page3: InstanceInvitationListPage = (
			page3Result as Extract<ListInstanceInvitationsStoreResult, { outcome: 'listed' }>
		).page;
		expect(page3.items).toHaveLength(1);
		expect(page3.items[0]?.id).toBe('01900000-0000-7000-8000-000000000001');
		expect(page3.nextCursor).toBeNull();

		// 3. Permissions
		const adminListResult: ListInstanceInvitationsStoreResult =
			await store().listInstanceInvitations(
				{ type: 'user', id: ADMIN_ID },
				{ cursor: null, limit: 10 }
			);
		expect(adminListResult.outcome).toBe('listed');

		const memberListResult: ListInstanceInvitationsStoreResult =
			await store().listInstanceInvitations(
				{ type: 'user', id: MEMBER_ID },
				{ cursor: null, limit: 10 }
			);
		expect(memberListResult).toEqual({ outcome: 'forbidden' });
	});

	it('accepts an invitation and enrolls a new active instance member', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await store().createInstanceInvitation(
			createCommand({ role: 'member', invitationId: INVITATION_ID, tokenHash: TOKEN_HASH })
		);

		const acceptResult: AcceptInstanceInvitationStoreResult =
			await store().acceptInstanceInvitation(
				acceptCommand({
					actor: { type: 'user', id: ACCEPTOR_ID },
					tokenHash: TOKEN_HASH,
					emailBinding: EMAIL_BINDING,
					acceptedAt: ACCEPTED_AT
				})
			);

		expect(acceptResult).toEqual({
			outcome: 'accepted',
			invitation: expect.objectContaining({
				id: INVITATION_ID,
				role: 'member',
				status: 'accepted',
				acceptedByUserId: ACCEPTOR_ID,
				acceptedAt: new Date(ACCEPTED_AT).toISOString(),
				revokedAt: null,
				revokedByUserId: null
			}),
			member: {
				userId: ACCEPTOR_ID,
				role: 'member',
				status: 'active',
				createdAt: new Date(ACCEPTED_AT).toISOString(),
				updatedAt: new Date(ACCEPTED_AT).toISOString()
			}
		});

		const memberRows: { userId: string; role: string; status: string }[] = await database()<
			{ userId: string; role: string; status: string }[]
		>`SELECT user_id AS "userId", role, status FROM instance_member WHERE user_id = ${ACCEPTOR_ID}`;
		expect(memberRows).toEqual([{ userId: ACCEPTOR_ID, role: 'member', status: 'active' }]);

		const invRows: { status: string; acceptedByUserId: string | null }[] = await database()<
			{ status: string; acceptedByUserId: string | null }[]
		>`SELECT status, accepted_by_user_id AS "acceptedByUserId" FROM instance_invitation WHERE id = ${INVITATION_ID}`;
		expect(invRows).toEqual([{ status: 'accepted', acceptedByUserId: ACCEPTOR_ID }]);

		const commandRows: { actorId: string; commandType: string; resultStatus: string }[] =
			await database()<
				{ actorId: string; commandType: string; resultStatus: string }[]
			>`SELECT actor_id AS "actorId", command_type AS "commandType", result_status AS "resultStatus"
				FROM instance_invitation_command WHERE actor_id = ${ACCEPTOR_ID}`;
		expect(commandRows).toEqual([
			{ actorId: ACCEPTOR_ID, commandType: 'accept', resultStatus: 'accepted' }
		]);
	});

	it('returns already_member, keeps original role, leaves a higher-role invitation pending, and writes zero accept receipts', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		const preexistingCreatedAt: string = '2026-09-01T12:00:00.000Z';
		await insertMember(MEMBER_ID, 'member', 'active', preexistingCreatedAt);

		// Owner invites for a higher 'admin' role than the pre-existing member's own role.
		await store().createInstanceInvitation(
			createCommand({ role: 'admin', invitationId: INVITATION_ID, tokenHash: TOKEN_HASH })
		);

		const acceptResult: AcceptInstanceInvitationStoreResult =
			await store().acceptInstanceInvitation(
				acceptCommand({
					actor: { type: 'user', id: MEMBER_ID },
					tokenHash: TOKEN_HASH,
					emailBinding: EMAIL_BINDING,
					acceptedAt: ACCEPTED_AT
				})
			);

		expect(acceptResult).toEqual({
			outcome: 'already_member',
			member: {
				userId: MEMBER_ID,
				role: 'member',
				status: 'active',
				createdAt: new Date(preexistingCreatedAt).toISOString(),
				updatedAt: new Date(preexistingCreatedAt).toISOString()
			}
		});

		const memberRoleRows: { role: string }[] = await database()<
			{ role: string }[]
		>`SELECT role FROM instance_member WHERE user_id = ${MEMBER_ID}`;
		expect(memberRoleRows).toEqual([{ role: 'member' }]);

		const invRows: { status: string; acceptedByUserId: string | null }[] = await database()<
			{ status: string; acceptedByUserId: string | null }[]
		>`SELECT status, accepted_by_user_id AS "acceptedByUserId" FROM instance_invitation WHERE id = ${INVITATION_ID}`;
		expect(invRows).toEqual([{ status: 'pending', acceptedByUserId: null }]);

		// Only the owner's earlier create receipt exists; the rolled-back
		// already_member accept never wrote a receipt for this invitation.
		const receiptRows: { commandType: string }[] = await database()<
			{ commandType: string }[]
		>`SELECT command_type AS "commandType" FROM instance_invitation_command WHERE invitation_id = ${INVITATION_ID}`;
		expect(receiptRows).toEqual([{ commandType: 'create' }]);
	});

	it('rejects suspended members across invitation methods', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(SUSPENDED_USER_ID, 'member', 'suspended');
		await insertMember(SUSPENDED_ADMIN_ID, 'admin', 'suspended');

		await store().createInstanceInvitation(
			createCommand({
				actor: { type: 'user', id: OWNER_ID },
				invitationId: INVITATION_ID,
				tokenHash: TOKEN_HASH
			})
		);

		// 1. Suspended user cannot accept
		const acceptRes: AcceptInstanceInvitationStoreResult = await store().acceptInstanceInvitation(
			acceptCommand({
				actor: { type: 'user', id: SUSPENDED_USER_ID },
				tokenHash: TOKEN_HASH
			})
		);
		expect(acceptRes).toEqual({ outcome: 'member_suspended' });

		// Invitation remains pending
		const invRows: { status: string }[] = await database()<
			{ status: string }[]
		>`SELECT status FROM instance_invitation WHERE id = ${INVITATION_ID}`;
		expect(invRows[0]?.status).toBe('pending');

		// 2. Suspended admin cannot create
		const createRes: CreateInstanceInvitationStoreResult = await store().createInstanceInvitation(
			createCommand({
				actor: { type: 'user', id: SUSPENDED_ADMIN_ID },
				invitationId: OTHER_INVITATION_ID,
				tokenHash: OTHER_TOKEN_HASH
			})
		);
		expect(createRes).toEqual({ outcome: 'member_suspended' });

		// 3. Suspended admin cannot revoke
		const revokeRes: RevokeInstanceInvitationStoreResult = await store().revokeInstanceInvitation(
			revokeCommand({
				actor: { type: 'user', id: SUSPENDED_ADMIN_ID },
				invitationId: INVITATION_ID
			})
		);
		expect(revokeRes).toEqual({ outcome: 'member_suspended' });

		// 4. Suspended admin cannot list
		const listRes: ListInstanceInvitationsStoreResult = await store().listInstanceInvitations(
			{ type: 'user', id: SUSPENDED_ADMIN_ID },
			listQuery()
		);
		expect(listRes).toEqual({ outcome: 'member_suspended' });
	});

	it('replays an accept request with original metadata when reminted with new acceptedAt', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await store().createInstanceInvitation(
			createCommand({ role: 'member', invitationId: INVITATION_ID, tokenHash: TOKEN_HASH })
		);

		const firstAcceptCmd: AcceptInstanceInvitationCommand = acceptCommand({
			actor: { type: 'user', id: ACCEPTOR_ID },
			idempotencyKey: 'accept-replay-key-1',
			requestFingerprint: REQUEST_FINGERPRINT,
			tokenHash: TOKEN_HASH,
			emailBinding: EMAIL_BINDING,
			acceptedAt: '2026-09-13T12:00:00.000Z'
		});
		const firstResult: AcceptInstanceInvitationStoreResult =
			await store().acceptInstanceInvitation(firstAcceptCmd);
		expect(firstResult.outcome).toBe('accepted');
		const originalInvitation: InstanceInvitationMetadata = (
			firstResult as Extract<AcceptInstanceInvitationStoreResult, { outcome: 'accepted' }>
		).invitation;
		const originalMember = (
			firstResult as Extract<AcceptInstanceInvitationStoreResult, { outcome: 'accepted' }>
		).member;

		// Replay under same actor, key, fingerprint, tokenHash, emailBinding, but NEW acceptedAt
		const replayAcceptCmd: AcceptInstanceInvitationCommand = acceptCommand({
			actor: { type: 'user', id: ACCEPTOR_ID },
			idempotencyKey: 'accept-replay-key-1',
			requestFingerprint: REQUEST_FINGERPRINT,
			tokenHash: TOKEN_HASH,
			emailBinding: EMAIL_BINDING,
			acceptedAt: '2026-09-13T12:05:00.000Z'
		});
		const replayResult: AcceptInstanceInvitationStoreResult =
			await store().acceptInstanceInvitation(replayAcceptCmd);

		expect(replayResult).toEqual({
			outcome: 'replayed',
			invitation: originalInvitation,
			member: originalMember
		});
		const replayedInv: InstanceInvitationMetadata = (
			replayResult as Extract<AcceptInstanceInvitationStoreResult, { outcome: 'replayed' }>
		).invitation;
		expect(replayedInv.acceptedAt).toBe('2026-09-13T12:00:00.000Z');

		const invRows: { acceptedAt: Date | string }[] = await database()<
			{ acceptedAt: Date | string }[]
		>`SELECT accepted_at AS "acceptedAt" FROM instance_invitation WHERE id = ${INVITATION_ID}`;
		expect(new Date(invRows[0]?.acceptedAt).toISOString()).toBe('2026-09-13T12:00:00.000Z');

		const commandRows: { occurredAt: Date | string }[] = await database()<
			{ occurredAt: Date | string }[]
		>`SELECT occurred_at AS "occurredAt" FROM instance_invitation_command WHERE command_type = 'accept'`;
		expect(commandRows).toHaveLength(1);
		expect(new Date(commandRows[0]?.occurredAt).toISOString()).toBe('2026-09-13T12:00:00.000Z');
	});

	it('resolves race between two different authenticated actors for one token to accepted+invitation_invalid with no loser member', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await store().createInstanceInvitation(
			createCommand({ role: 'member', invitationId: INVITATION_ID, tokenHash: TOKEN_HASH })
		);

		const actorA: string = 'user-race-acceptor-a';
		const actorB: string = 'user-race-acceptor-b';

		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly SynchronizedAcceptStore[] = synchronizeAccept([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const cmdA: AcceptInstanceInvitationCommand = acceptCommand({
				actor: { type: 'user', id: actorA },
				idempotencyKey: 'race-accept-a',
				requestFingerprint: 'a'.repeat(64),
				tokenHash: TOKEN_HASH,
				emailBinding: EMAIL_BINDING,
				acceptedAt: '2026-09-13T12:01:00.000Z'
			});
			const cmdB: AcceptInstanceInvitationCommand = acceptCommand({
				actor: { type: 'user', id: actorB },
				idempotencyKey: 'race-accept-b',
				requestFingerprint: 'b'.repeat(64),
				tokenHash: TOKEN_HASH,
				emailBinding: EMAIL_BINDING,
				acceptedAt: '2026-09-13T12:02:00.000Z'
			});

			const [first, second]: AcceptInstanceInvitationStoreResult[] = await Promise.all([
				storeA.acceptInstanceInvitation(cmdA),
				storeB.acceptInstanceInvitation(cmdB)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['accepted', 'invitation_invalid']);

			const winnerResult: Extract<AcceptInstanceInvitationStoreResult, { outcome: 'accepted' }> = (
				first.outcome === 'accepted' ? first : second
			) as Extract<AcceptInstanceInvitationStoreResult, { outcome: 'accepted' }>;
			const winnerId: string = winnerResult.member.userId;
			const loserId: string = winnerId === actorA ? actorB : actorA;

			// The loser must NOT exist in instance_member
			const memberRows: { userId: string }[] = await database()<
				{ userId: string }[]
			>`SELECT user_id AS "userId" FROM instance_member WHERE user_id IN (${actorA}, ${actorB})`;
			expect(memberRows).toEqual([{ userId: winnerId }]);

			const loserRows: { userId: string }[] = await database()<
				{ userId: string }[]
			>`SELECT user_id AS "userId" FROM instance_member WHERE user_id = ${loserId}`;
			expect(loserRows).toHaveLength(0);

			// The invitation belongs to the winner
			const invRows: { acceptedByUserId: string | null }[] = await database()<
				{ acceptedByUserId: string | null }[]
			>`SELECT accepted_by_user_id AS "acceptedByUserId" FROM instance_invitation WHERE id = ${INVITATION_ID}`;
			expect(invRows[0]?.acceptedByUserId).toBe(winnerId);

			// Exactly one accept receipt exists
			const receiptRows: { actorId: string }[] = await database()<
				{ actorId: string }[]
			>`SELECT actor_id AS "actorId" FROM instance_invitation_command WHERE command_type = 'accept'`;
			expect(receiptRows).toEqual([{ actorId: winnerId }]);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('concurrently accepting two different pending invitations as the same previously-new actor consumes exactly one invitation', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await store().createInstanceInvitation(
			createCommand({
				idempotencyKey: 'race-create-1',
				invitationId: INVITATION_ID,
				role: 'member',
				tokenHash: TOKEN_HASH,
				emailBinding: EMAIL_BINDING
			})
		);
		await store().createInstanceInvitation(
			createCommand({
				idempotencyKey: 'race-create-2',
				invitationId: OTHER_INVITATION_ID,
				role: 'admin',
				tokenHash: OTHER_TOKEN_HASH,
				emailBinding: EMAIL_BINDING
			})
		);

		const raceActor: string = 'user-race-new-actor';

		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly SynchronizedAcceptStore[] = synchronizeAccept([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const cmdA: AcceptInstanceInvitationCommand = acceptCommand({
				actor: { type: 'user', id: raceActor },
				idempotencyKey: 'race-accept-a',
				requestFingerprint: 'a'.repeat(64),
				tokenHash: TOKEN_HASH,
				emailBinding: EMAIL_BINDING,
				acceptedAt: '2026-09-13T12:01:00.000Z'
			});
			const cmdB: AcceptInstanceInvitationCommand = acceptCommand({
				actor: { type: 'user', id: raceActor },
				idempotencyKey: 'race-accept-b',
				requestFingerprint: 'b'.repeat(64),
				tokenHash: OTHER_TOKEN_HASH,
				emailBinding: EMAIL_BINDING,
				acceptedAt: '2026-09-13T12:02:00.000Z'
			});

			const [first, second]: AcceptInstanceInvitationStoreResult[] = await Promise.all([
				storeA.acceptInstanceInvitation(cmdA),
				storeB.acceptInstanceInvitation(cmdB)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['accepted', 'already_member']);

			// Exactly one member row for the race actor, from whichever invitation won.
			const members: { userId: string; role: string }[] = await database()<
				{ userId: string; role: string }[]
			>`SELECT user_id AS "userId", role FROM instance_member WHERE user_id = ${raceActor}`;
			expect(members).toHaveLength(1);
			const wonRole: string = members[0].role;
			expect(['member', 'admin']).toContain(wonRole);

			const winnerInvitationId: string = wonRole === 'member' ? INVITATION_ID : OTHER_INVITATION_ID;
			const loserInvitationId: string = wonRole === 'member' ? OTHER_INVITATION_ID : INVITATION_ID;

			const winnerInv: { status: string; acceptedByUserId: string | null }[] = await database()<
				{ status: string; acceptedByUserId: string | null }[]
			>`SELECT status, accepted_by_user_id AS "acceptedByUserId" FROM instance_invitation WHERE id = ${winnerInvitationId}`;
			expect(winnerInv[0]?.status).toBe('accepted');
			expect(winnerInv[0]?.acceptedByUserId).toBe(raceActor);

			// The losing invitation must remain pending and unconsumed.
			const loserInv: {
				status: string;
				acceptedAt: Date | string | null;
				acceptedByUserId: string | null;
			}[] = await database()<
				{ status: string; acceptedAt: Date | string | null; acceptedByUserId: string | null }[]
			>`SELECT status, accepted_at AS "acceptedAt", accepted_by_user_id AS "acceptedByUserId" FROM instance_invitation WHERE id = ${loserInvitationId}`;
			expect(loserInv[0]?.status).toBe('pending');
			expect(loserInv[0]?.acceptedAt).toBeNull();
			expect(loserInv[0]?.acceptedByUserId).toBeNull();

			// Exactly one accept receipt exists, tied to the winning invitation.
			const receiptRows: { invitationId: string }[] = await database()<
				{ invitationId: string }[]
			>`SELECT invitation_id AS "invitationId" FROM instance_invitation_command WHERE command_type = 'accept'`;
			expect(receiptRows).toEqual([{ invitationId: winnerInvitationId }]);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('does not enroll a member when accepting a revoked invitation', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await store().createInstanceInvitation(createCommand());
		expect((await store().revokeInstanceInvitation(revokeCommand())).outcome).toBe('revoked');

		// The member INSERT runs before the invitation UPDATE (accepted_by_user_id
		// is a foreign key into instance_member), so a stale invitation must take
		// the whole transaction down with it rather than leave a member behind.
		const result: AcceptInstanceInvitationStoreResult =
			await store().acceptInstanceInvitation(acceptCommand());
		expect(result).toEqual({ outcome: 'invitation_invalid' });

		const acceptorRows: { userId: string }[] = await database()<
			{ userId: string }[]
		>`SELECT user_id AS "userId" FROM instance_member WHERE user_id = ${ACCEPTOR_ID}`;
		expect(acceptorRows).toHaveLength(0);

		const invRows: { status: string; acceptedByUserId: string | null }[] = await database()<
			{ status: string; acceptedByUserId: string | null }[]
		>`SELECT status, accepted_by_user_id AS "acceptedByUserId" FROM instance_invitation WHERE id = ${INVITATION_ID}`;
		expect(invRows[0]?.status).toBe('revoked');
		expect(invRows[0]?.acceptedByUserId).toBeNull();

		const acceptReceipts: { actorId: string }[] = await database()<
			{ actorId: string }[]
		>`SELECT actor_id AS "actorId" FROM instance_invitation_command WHERE command_type = 'accept'`;
		expect(acceptReceipts).toHaveLength(0);
	});

	it('enforces revoke owner and admin role ceiling and replays safely with new revokedAt', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(ADMIN_ID, 'admin');
		await insertMember(MEMBER_ID, 'member');

		const invAdminId: string = '01900000-0000-7000-8000-000000000010';
		const invMemberId: string = '01900000-0000-7000-8000-000000000020';
		const invReplayId: string = '01900000-0000-7000-8000-000000000030';

		await store().createInstanceInvitation(
			createCommand({
				actor: { type: 'user', id: OWNER_ID },
				idempotencyKey: 'revoke-setup-admin',
				invitationId: invAdminId,
				role: 'admin',
				tokenHash: 'a'.repeat(64)
			})
		);
		await store().createInstanceInvitation(
			createCommand({
				actor: { type: 'user', id: OWNER_ID },
				idempotencyKey: 'revoke-setup-member',
				invitationId: invMemberId,
				role: 'member',
				tokenHash: 'b'.repeat(64)
			})
		);
		await store().createInstanceInvitation(
			createCommand({
				actor: { type: 'user', id: OWNER_ID },
				idempotencyKey: 'revoke-setup-replay',
				invitationId: invReplayId,
				role: 'member',
				tokenHash: 'c'.repeat(64)
			})
		);

		// 1. Role ceiling: Admin cannot revoke admin-role invitation
		const adminRevokeAdmin: RevokeInstanceInvitationStoreResult =
			await store().revokeInstanceInvitation(
				revokeCommand({
					actor: { type: 'user', id: ADMIN_ID },
					idempotencyKey: 'admin-revoke-admin',
					invitationId: invAdminId
				})
			);
		expect(adminRevokeAdmin).toEqual({ outcome: 'forbidden' });

		// InvAdminId remains pending
		const pendingInv: { status: string }[] = await database()<
			{ status: string }[]
		>`SELECT status FROM instance_invitation WHERE id = ${invAdminId}`;
		expect(pendingInv[0]?.status).toBe('pending');

		// Regular member cannot revoke
		const memberRevokeMember: RevokeInstanceInvitationStoreResult =
			await store().revokeInstanceInvitation(
				revokeCommand({
					actor: { type: 'user', id: MEMBER_ID },
					idempotencyKey: 'member-revoke-member',
					invitationId: invMemberId
				})
			);
		expect(memberRevokeMember).toEqual({ outcome: 'forbidden' });

		// Admin CAN revoke member-role invitation
		const adminRevokeMember: RevokeInstanceInvitationStoreResult =
			await store().revokeInstanceInvitation(
				revokeCommand({
					actor: { type: 'user', id: ADMIN_ID },
					idempotencyKey: 'admin-revoke-member',
					invitationId: invMemberId
				})
			);
		expect(adminRevokeMember).toEqual({
			outcome: 'revoked',
			invitation: expect.objectContaining({
				id: invMemberId,
				role: 'member',
				status: 'revoked',
				revokedByUserId: ADMIN_ID
			})
		});

		// Owner CAN revoke admin-role invitation
		const ownerRevokeAdmin: RevokeInstanceInvitationStoreResult =
			await store().revokeInstanceInvitation(
				revokeCommand({
					actor: { type: 'user', id: OWNER_ID },
					idempotencyKey: 'owner-revoke-admin',
					invitationId: invAdminId
				})
			);
		expect(ownerRevokeAdmin).toEqual({
			outcome: 'revoked',
			invitation: expect.objectContaining({
				id: invAdminId,
				role: 'admin',
				status: 'revoked',
				revokedByUserId: OWNER_ID
			})
		});

		// 2. Replay with new revokedAt
		const firstRevokeCmd: RevokeInstanceInvitationCommand = revokeCommand({
			actor: { type: 'user', id: OWNER_ID },
			idempotencyKey: 'revoke-replay-key-1',
			requestFingerprint: REQUEST_FINGERPRINT,
			invitationId: invReplayId,
			revokedAt: '2026-09-13T12:00:00.000Z'
		});
		const firstRevokeResult: RevokeInstanceInvitationStoreResult =
			await store().revokeInstanceInvitation(firstRevokeCmd);
		expect(firstRevokeResult.outcome).toBe('revoked');
		const originalRevokedInv: InstanceInvitationMetadata = (
			firstRevokeResult as Extract<RevokeInstanceInvitationStoreResult, { outcome: 'revoked' }>
		).invitation;

		const replayRevokeCmd: RevokeInstanceInvitationCommand = revokeCommand({
			actor: { type: 'user', id: OWNER_ID },
			idempotencyKey: 'revoke-replay-key-1',
			requestFingerprint: REQUEST_FINGERPRINT,
			invitationId: invReplayId,
			revokedAt: '2026-09-13T12:20:00.000Z'
		});
		const replayRevokeResult: RevokeInstanceInvitationStoreResult =
			await store().revokeInstanceInvitation(replayRevokeCmd);

		expect(replayRevokeResult).toEqual({
			outcome: 'replayed',
			invitation: originalRevokedInv
		});
		const replayedRevokedInv: InstanceInvitationMetadata = (
			replayRevokeResult as Extract<RevokeInstanceInvitationStoreResult, { outcome: 'replayed' }>
		).invitation;
		expect(replayedRevokedInv.revokedAt).toBe('2026-09-13T12:00:00.000Z');

		const invRows: { revokedAt: Date | string }[] = await database()<
			{ revokedAt: Date | string }[]
		>`SELECT revoked_at AS "revokedAt" FROM instance_invitation WHERE id = ${invReplayId}`;
		expect(new Date(invRows[0]?.revokedAt).toISOString()).toBe('2026-09-13T12:00:00.000Z');

		const commandRows: { occurredAt: Date | string }[] = await database()<
			{ occurredAt: Date | string }[]
		>`SELECT occurred_at AS "occurredAt" FROM instance_invitation_command WHERE invitation_id = ${invReplayId} AND command_type = 'revoke'`;
		expect(commandRows).toHaveLength(1);
		expect(new Date(commandRows[0]?.occurredAt).toISOString()).toBe('2026-09-13T12:00:00.000Z');
	});

	it('lists members for owner/admin with deterministic user_id-ascending pagination, and forbids member/suspended/unknown actors', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(ADMIN_ID, 'admin');
		await insertMember('member-a', 'member');
		await insertMember('member-b', 'member');
		await insertMember('member-c', 'member');

		const page1Result: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: OWNER_ID },
			memberListQuery({ limit: 2 })
		);
		expect(page1Result.outcome).toBe('listed');
		const page1: InstanceMemberListPage = (
			page1Result as Extract<ListInstanceMembersStoreResult, { outcome: 'listed' }>
		).page;
		expect(page1.items.map((item) => item.userId)).toEqual(['member-a', 'member-b']);
		expect(page1.nextCursor).toBe('member-b');

		const page2Result: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: OWNER_ID },
			memberListQuery({ cursor: page1.nextCursor, limit: 3 })
		);
		expect(page2Result.outcome).toBe('listed');
		const page2: InstanceMemberListPage = (
			page2Result as Extract<ListInstanceMembersStoreResult, { outcome: 'listed' }>
		).page;
		// Ascending by user_id: 'user-admin-1' sorts before 'user-owner-1'.
		expect(page2.items.map((item) => item.userId)).toEqual(['member-c', ADMIN_ID, OWNER_ID]);
		expect(page2.nextCursor).toBeNull();

		const adminList: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: ADMIN_ID },
			memberListQuery()
		);
		expect(adminList.outcome).toBe('listed');

		const memberList: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: 'member-a' },
			memberListQuery()
		);
		expect(memberList).toEqual({ outcome: 'forbidden' });

		const ghostList: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: 'ghost' },
			memberListQuery()
		);
		expect(ghostList).toEqual({ outcome: 'forbidden' });

		await database()`UPDATE instance_member SET status = 'suspended' WHERE user_id = ${OWNER_ID}`;
		const suspendedList: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: OWNER_ID },
			memberListQuery()
		);
		expect(suspendedList).toEqual({ outcome: 'member_suspended' });
	});

	it('orders and paginates members by user_id in raw byte order across mixed-case and Unicode ids, matching D1/SQLite BINARY collation', async (): Promise<void> => {
		// This container runs on musl libc (Alpine), whose "locale" support is
		// effectively always byte order, so it cannot by itself demonstrate a
		// PostgreSQL default-collation divergence the way a glibc/ICU-backed
		// PostgreSQL (e.g. most managed cloud instances) could. The explicit
		// COLLATE "C" in the query still pins the guarantee independently of
		// the underlying platform's default collation, and this test fixes
		// the expected byte order across digits, ASCII case, '_', and two
		// non-ASCII BMP characters so a regression to unqualified `user_id`
		// ordering would be caught wherever the default collation differs.
		await insertMember(OWNER_ID, 'owner');
		const ids: readonly string[] = [
			'1-digit',
			'A-upper',
			'_underscore',
			'a-lower',
			'é-eacute',
			'Ω-omega'
		];
		for (const id of ids) {
			await insertMember(id, 'member');
		}

		const page1Result: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: OWNER_ID },
			memberListQuery({ limit: 3 })
		);
		expect(page1Result.outcome).toBe('listed');
		const page1: InstanceMemberListPage = (
			page1Result as Extract<ListInstanceMembersStoreResult, { outcome: 'listed' }>
		).page;
		expect(page1.items.map((item) => item.userId)).toEqual(['1-digit', 'A-upper', '_underscore']);
		expect(page1.nextCursor).toBe('_underscore');

		const page2Result: ListInstanceMembersStoreResult = await store().listInstanceMembers(
			{ type: 'user', id: OWNER_ID },
			memberListQuery({ cursor: page1.nextCursor, limit: 10 })
		);
		expect(page2Result.outcome).toBe('listed');
		const page2: InstanceMemberListPage = (
			page2Result as Extract<ListInstanceMembersStoreResult, { outcome: 'listed' }>
		).page;
		expect(page2.items.map((item) => item.userId)).toEqual([
			'a-lower',
			OWNER_ID,
			'é-eacute',
			'Ω-omega'
		]);
		expect(page2.nextCursor).toBeNull();
	});

	it('lets an owner administer any member, lets an admin administer only current member-role targets, and never grants above member from an admin', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(ADMIN_ID, 'admin');
		await insertMember(TARGET_ID, 'member');
		await insertMember('other-admin', 'admin');

		// Owner can promote a member to admin.
		const ownerPromotes: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ idempotencyKey: 'owner-promotes', role: 'admin' })
		);
		expect(ownerPromotes.outcome).toBe('updated');

		// Admin cannot grant a role above member, even to a current member target.
		await insertMember('member-2', 'member');
		const adminGrantsOwner: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				actor: { type: 'user', id: ADMIN_ID },
				idempotencyKey: 'admin-grants-owner',
				targetUserId: 'member-2',
				role: 'owner'
			})
		);
		expect(adminGrantsOwner).toEqual({ outcome: 'role_not_permitted' });

		const adminGrantsAdmin: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				actor: { type: 'user', id: ADMIN_ID },
				idempotencyKey: 'admin-grants-admin',
				targetUserId: 'member-2',
				role: 'admin'
			})
		);
		expect(adminGrantsAdmin).toEqual({ outcome: 'role_not_permitted' });

		// Admin cannot administer a non-member (current role is not 'member').
		const adminTargetsAdmin: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				actor: { type: 'user', id: ADMIN_ID },
				idempotencyKey: 'admin-targets-admin',
				targetUserId: 'other-admin',
				role: 'member'
			})
		);
		expect(adminTargetsAdmin).toEqual({ outcome: 'forbidden' });

		const adminSuspendsAdmin: SetInstanceMemberStatusStoreResult =
			await store().setInstanceMemberStatus(
				setStatusCommand({
					actor: { type: 'user', id: ADMIN_ID },
					idempotencyKey: 'admin-suspends-admin',
					targetUserId: 'other-admin'
				})
			);
		expect(adminSuspendsAdmin).toEqual({ outcome: 'forbidden' });

		// Admin CAN administer a current member-role target.
		const adminSuspendsMember: SetInstanceMemberStatusStoreResult =
			await store().setInstanceMemberStatus(
				setStatusCommand({
					actor: { type: 'user', id: ADMIN_ID },
					idempotencyKey: 'admin-suspends-member',
					targetUserId: 'member-2'
				})
			);
		expect(adminSuspendsMember.outcome).toBe('updated');
	});

	it('blocks demoting or suspending the sole active owner, but allows it once another active owner exists', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');

		const demoteAlone: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ targetUserId: OWNER_ID, role: 'admin', idempotencyKey: 'demote-alone' })
		);
		expect(demoteAlone).toEqual({ outcome: 'last_active_owner' });

		await insertMember(OWNER2_ID, 'owner');
		const suspendOther: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({
				actor: { type: 'user', id: OWNER_ID },
				targetUserId: OWNER2_ID,
				idempotencyKey: 'suspend-with-backup'
			})
		);
		expect(suspendOther.outcome).toBe('updated');

		// Now OWNER_ID is the sole active owner again (OWNER2_ID suspended).
		const demoteWithoutBackup: SetInstanceMemberRoleStoreResult =
			await store().setInstanceMemberRole(
				setRoleCommand({
					targetUserId: OWNER_ID,
					role: 'admin',
					idempotencyKey: 'demote-without-backup'
				})
			);
		expect(demoteWithoutBackup).toEqual({ outcome: 'last_active_owner' });
	});

	it('allows role self-handoff for an active owner but always rejects status self-targeting', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(OWNER2_ID, 'owner');

		const selfHandoff: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				actor: { type: 'user', id: OWNER_ID },
				targetUserId: OWNER_ID,
				role: 'admin',
				idempotencyKey: 'self-handoff'
			})
		);
		expect(selfHandoff.outcome).toBe('updated');
		if (selfHandoff.outcome === 'updated') {
			expect(selfHandoff.member).toEqual(
				expect.objectContaining({ userId: OWNER_ID, role: 'admin' })
			);
		}

		const selfStatus: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({
				actor: { type: 'user', id: OWNER2_ID },
				targetUserId: OWNER2_ID,
				idempotencyKey: 'self-status'
			})
		);
		expect(selfStatus).toEqual({ outcome: 'cannot_target_self' });
	});

	it('replays the originally recorded role state, not state produced by a later command', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(TARGET_ID, 'member');

		const first: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ role: 'admin', idempotencyKey: 'role-replay-1' })
		);
		expect(first.outcome).toBe('updated');

		await store().setInstanceMemberRole(
			setRoleCommand({ role: 'member', idempotencyKey: 'role-replay-2', updatedAt: LATER_AT })
		);

		const replay: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ role: 'admin', idempotencyKey: 'role-replay-1', updatedAt: LATER_AT })
		);
		expect(replay).toEqual({
			outcome: 'replayed',
			member: {
				userId: TARGET_ID,
				role: 'admin',
				status: 'active',
				createdAt: new Date(CREATED_AT).toISOString(),
				updatedAt: new Date(UPDATED_AT).toISOString()
			},
			appliedAt: new Date(UPDATED_AT).toISOString(),
			revokedInvitationCount: 0
		});

		const currentRole: { role: string }[] = await database()<
			{ role: string }[]
		>`SELECT role FROM instance_member WHERE user_id = ${TARGET_ID}`;
		expect(currentRole[0]?.role).toBe('member');
	});

	it('replays the originally recorded status state, not state produced by a later command', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(TARGET_ID, 'member');

		const first: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({ status: 'suspended', idempotencyKey: 'status-replay-1' })
		);
		expect(first.outcome).toBe('updated');

		await store().setInstanceMemberStatus(
			setStatusCommand({
				status: 'active',
				idempotencyKey: 'status-replay-2',
				updatedAt: LATER_AT
			})
		);

		const replay: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({
				status: 'suspended',
				idempotencyKey: 'status-replay-1',
				updatedAt: LATER_AT
			})
		);
		expect(replay).toEqual({
			outcome: 'replayed',
			member: {
				userId: TARGET_ID,
				role: 'member',
				status: 'suspended',
				createdAt: new Date(CREATED_AT).toISOString(),
				updatedAt: new Date(UPDATED_AT).toISOString()
			},
			appliedAt: new Date(UPDATED_AT).toISOString(),
			revokedInvitationCount: 0
		});

		const currentStatus: { status: string }[] = await database()<
			{ status: string }[]
		>`SELECT status FROM instance_member WHERE user_id = ${TARGET_ID}`;
		expect(currentStatus[0]?.status).toBe('active');
	});

	it('returns replayed for exact set-role replay after the actor is later demoted or suspended by another owner', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(OWNER2_ID, 'owner');
		await insertMember(TARGET_ID, 'member');

		const cmd: SetInstanceMemberRoleCommand = setRoleCommand({
			role: 'admin',
			idempotencyKey: 'role-replay-actor-demoted-or-suspended'
		});
		const first: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(cmd);
		expect(first.outcome).toBe('updated');

		// Another owner demotes the acting owner to plain member.
		const demoteActor: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				actor: { type: 'user', id: OWNER2_ID },
				targetUserId: OWNER_ID,
				role: 'member',
				idempotencyKey: 'owner2-demotes-owner1',
				updatedAt: LATER_AT
			})
		);
		expect(demoteActor.outcome).toBe('updated');

		// Demoted actor's exact replay still succeeds with replayed.
		const demotedReplay: SetInstanceMemberRoleStoreResult =
			await store().setInstanceMemberRole(cmd);
		expect(demotedReplay.outcome).toBe('replayed');

		// Another owner suspends the actor.
		const suspendActor: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({
				actor: { type: 'user', id: OWNER2_ID },
				targetUserId: OWNER_ID,
				status: 'suspended',
				idempotencyKey: 'owner2-suspends-owner1',
				updatedAt: '2026-09-15T13:00:00.000Z'
			})
		);
		expect(suspendActor.outcome).toBe('updated');

		// Suspended actor's exact replay still succeeds with replayed.
		const suspendedReplay: SetInstanceMemberRoleStoreResult =
			await store().setInstanceMemberRole(cmd);
		expect(suspendedReplay.outcome).toBe('replayed');
	});

	it('returns replayed for exact set-status replay after the actor is later demoted or suspended by another owner', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(OWNER2_ID, 'owner');
		await insertMember(TARGET_ID, 'member');

		const cmd: SetInstanceMemberStatusCommand = setStatusCommand({
			status: 'suspended',
			idempotencyKey: 'status-replay-actor-demoted-or-suspended'
		});
		const first: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(cmd);
		expect(first.outcome).toBe('updated');

		// Another owner demotes the acting owner to plain member.
		const demoteActor: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				actor: { type: 'user', id: OWNER2_ID },
				targetUserId: OWNER_ID,
				role: 'member',
				idempotencyKey: 'owner2-demotes-owner1-status',
				updatedAt: LATER_AT
			})
		);
		expect(demoteActor.outcome).toBe('updated');

		// Demoted actor's exact replay still succeeds with replayed.
		const demotedReplay: SetInstanceMemberStatusStoreResult =
			await store().setInstanceMemberStatus(cmd);
		expect(demotedReplay.outcome).toBe('replayed');

		// Another owner suspends the actor.
		const suspendActor: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({
				actor: { type: 'user', id: OWNER2_ID },
				targetUserId: OWNER_ID,
				status: 'suspended',
				idempotencyKey: 'owner2-suspends-owner1-status',
				updatedAt: '2026-09-15T13:00:00.000Z'
			})
		);
		expect(suspendActor.outcome).toBe('updated');

		// Suspended actor's exact replay still succeeds with replayed.
		const suspendedReplay: SetInstanceMemberStatusStoreResult =
			await store().setInstanceMemberStatus(cmd);
		expect(suspendedReplay.outcome).toBe('replayed');
	});

	it('returns integrity_error and leaves member and receipt unchanged when command updatedAt is older than target updatedAt', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(TARGET_ID, 'member');

		const initial: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				role: 'admin',
				idempotencyKey: 'initial-role-command',
				updatedAt: UPDATED_AT
			})
		);
		expect(initial.outcome).toBe('updated');

		const olderRole: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({
				role: 'member',
				idempotencyKey: 'older-role-command',
				updatedAt: CREATED_AT
			})
		);
		expect(olderRole).toEqual({ outcome: 'integrity_error' });

		const olderStatus: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({
				status: 'suspended',
				idempotencyKey: 'older-status-command',
				updatedAt: CREATED_AT
			})
		);
		expect(olderStatus).toEqual({ outcome: 'integrity_error' });

		const targetRows: { role: string; status: string; updatedAt: string }[] = await database()<
			{ role: string; status: string; updatedAt: string }[]
		>`SELECT role, status, updated_at AS "updatedAt" FROM instance_member WHERE user_id = ${TARGET_ID}`;
		expect(targetRows[0]?.role).toBe('admin');
		expect(targetRows[0]?.status).toBe('active');
		expect(new Date(targetRows[0]?.updatedAt as string).toISOString()).toBe(
			new Date(UPDATED_AT).toISOString()
		);

		const receiptRows: { idempotencyKey: string }[] = await database()<
			{ idempotencyKey: string }[]
		>`SELECT idempotency_key AS "idempotencyKey" FROM instance_member_command WHERE target_user_id = ${TARGET_ID}`;
		expect(receiptRows).toHaveLength(1);
		expect(receiptRows[0]?.idempotencyKey).toBe('initial-role-command');
	});

	it('rejects a reused idempotency key with a conflicting request fingerprint for role and status commands', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(TARGET_ID, 'member');

		await store().setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
		const roleConflict: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ role: 'admin', requestFingerprint: OTHER_REQUEST_FINGERPRINT })
		);
		expect(roleConflict).toEqual({ outcome: 'idempotency_conflict' });

		await store().setInstanceMemberStatus(setStatusCommand({ status: 'suspended' }));
		const statusConflict: SetInstanceMemberStatusStoreResult =
			await store().setInstanceMemberStatus(
				setStatusCommand({ status: 'suspended', requestFingerprint: OTHER_REQUEST_FINGERPRINT })
			);
		expect(statusConflict).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('cascades only the non-member invitations the target can no longer hold on an owner->admin demotion', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(TARGET_ID, 'owner');
		await database()`
			INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id,
				created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
			) VALUES (
				${INVITATION_ID}, 'owner', 'pending', ${TOKEN_HASH}, ${EMAIL_BINDING}, ${TARGET_ID},
				${CREATED_AT}::timestamptz, ${EXPIRES_AT}::timestamptz, NULL, NULL, NULL, NULL
			)
		`;
		await database()`
			INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id,
				created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
			) VALUES (
				${OTHER_INVITATION_ID}, 'member', 'pending', ${OTHER_TOKEN_HASH}, ${EMAIL_BINDING}, ${TARGET_ID},
				${CREATED_AT}::timestamptz, ${EXPIRES_AT}::timestamptz, NULL, NULL, NULL, NULL
			)
		`;

		const result: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ role: 'admin' })
		);
		expect(result.outcome).toBe('updated');
		if (result.outcome === 'updated') expect(result.revokedInvitationCount).toBe(1);

		const statuses: { id: string; status: string }[] = await database()<
			{ id: string; status: string }[]
		>`SELECT id, status FROM instance_invitation ORDER BY id`;
		expect(statuses).toEqual([
			{ id: INVITATION_ID, status: 'revoked' },
			{ id: OTHER_INVITATION_ID, status: 'pending' }
		]);
	});

	it('cascades every pending invitation of the target on a demotion to member and on a suspension, but nothing on promotion or reactivation', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(TARGET_ID, 'admin');
		await database()`
			INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id,
				created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
			) VALUES (
				${INVITATION_ID}, 'member', 'pending', ${TOKEN_HASH}, ${EMAIL_BINDING}, ${TARGET_ID},
				${CREATED_AT}::timestamptz, ${EXPIRES_AT}::timestamptz, NULL, NULL, NULL, NULL
			)
		`;

		const demote: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ role: 'member', idempotencyKey: 'demote-to-member' })
		);
		expect(demote.outcome).toBe('updated');
		if (demote.outcome === 'updated') expect(demote.revokedInvitationCount).toBe(1);

		// Promotion cascades nothing.
		const promote: SetInstanceMemberRoleStoreResult = await store().setInstanceMemberRole(
			setRoleCommand({ role: 'owner', idempotencyKey: 'promote-back' })
		);
		expect(promote.outcome).toBe('updated');
		if (promote.outcome === 'updated') expect(promote.revokedInvitationCount).toBe(0);

		await database()`
			INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id,
				created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
			) VALUES (
				${OTHER_INVITATION_ID}, 'member', 'pending', ${OTHER_TOKEN_HASH}, ${EMAIL_BINDING}, ${TARGET_ID},
				${CREATED_AT}::timestamptz, ${EXPIRES_AT}::timestamptz, NULL, NULL, NULL, NULL
			)
		`;
		const suspend: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({ idempotencyKey: 'suspend-cascade' })
		);
		expect(suspend.outcome).toBe('updated');
		if (suspend.outcome === 'updated') expect(suspend.revokedInvitationCount).toBe(1);

		// Reactivation cascades nothing.
		const reactivate: SetInstanceMemberStatusStoreResult = await store().setInstanceMemberStatus(
			setStatusCommand({ status: 'active', idempotencyKey: 'reactivate' })
		);
		expect(reactivate.outcome).toBe('updated');
		if (reactivate.outcome === 'updated') expect(reactivate.revokedInvitationCount).toBe(0);

		const otherInv: { status: string }[] = await database()<
			{ status: string }[]
		>`SELECT status FROM instance_invitation WHERE id = ${OTHER_INVITATION_ID}`;
		expect(otherInv[0]?.status).toBe('revoked');
	});

	/**
	 * The core write-skew regression test for the shared member-admin advisory
	 * lock: under plain READ COMMITTED and per-row locking alone, two owners
	 * concurrently demoting each other would each read the other's row as
	 * still an active owner and both succeed, leaving zero active owners. The
	 * lock serializes the two mutations so the second always re-reads the
	 * first's already-committed result, and this also exercises the
	 * deterministic actor/target row-lock ordering: two symmetric mutations
	 * (owner A targeting owner B, and owner B targeting owner A) always
	 * request their locks in the same sorted order and so never deadlock.
	 *
	/**
	 * The core write-skew regression test for the shared member-admin advisory
	 * lock: under plain READ COMMITTED and per-row locking alone, two owners
	 * concurrently demoting each other would each read the other's row as
	 * still an active owner and both succeed, leaving zero active owners. The
	 * lock serializes the two mutations so the second always re-reads the
	 * first's already-committed result, and this also exercises the
	 * deterministic actor/target row-lock ordering: two symmetric mutations
	 * (owner A targeting owner B, and owner B targeting owner A) always
	 * request their locks in the same sorted order and so never deadlock.
	 *
	 * Whichever demotion commits first turns its actor into a plain admin.
	 * When the second demotion runs, its actor is now an admin requesting
	 * a role above member (role: 'admin'), which fails with 'role_not_permitted'
	 * under the Opus-directed outcome ordering ahead of checking target role.
	 * The invariant this test actually protects -- never both succeed, and
	 * exactly one active owner survives -- holds either way.
	 */
	it('resolves two owners concurrently demoting each other to exactly one updated and one role_not_permitted, leaving one active owner and one admin', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(OWNER2_ID, 'owner');

		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly SynchronizedSetRoleStore[] = synchronizeSetRole([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const cmdA: SetInstanceMemberRoleCommand = setRoleCommand({
				actor: { type: 'user', id: OWNER_ID },
				idempotencyKey: 'demote-a-targets-b',
				targetUserId: OWNER2_ID,
				role: 'admin'
			});
			const cmdB: SetInstanceMemberRoleCommand = setRoleCommand({
				actor: { type: 'user', id: OWNER2_ID },
				idempotencyKey: 'demote-b-targets-a',
				targetUserId: OWNER_ID,
				role: 'admin'
			});

			const [first, second]: SetInstanceMemberRoleStoreResult[] = await Promise.all([
				storeA.setInstanceMemberRole(cmdA),
				storeB.setInstanceMemberRole(cmdB)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['role_not_permitted', 'updated']);

			const owners: { userId: string; role: string; status: string }[] = await database()<
				{ userId: string; role: string; status: string }[]
			>`SELECT user_id AS "userId", role, status FROM instance_member WHERE role = 'owner' AND status = 'active'`;
			expect(owners).toHaveLength(1);

			const allMembers: { userId: string; role: string }[] = await database()<
				{ userId: string; role: string }[]
			>`SELECT user_id AS "userId", role FROM instance_member ORDER BY user_id`;
			expect(allMembers).toHaveLength(2);
			expect(allMembers.filter((m) => m.role === 'admin')).toHaveLength(1);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	/**
	 * The literal write-skew race the owner floor exists to prevent: two
	 * owners each performing a role self-handoff concurrently. Unlike
	 * targeting each other (above), self-handoff never touches the other
	 * command's actor row, so the second command's own authorization is
	 * unaffected by the first -- its self-targeted owner-floor check is what
	 * decides the outcome, and it deterministically lands on
	 * 'last_active_owner' once the first commit leaves it the sole owner.
	 * Without the shared advisory lock, both would read the other as still
	 * an active owner and both would succeed, leaving zero active owners.
	 */
	it('resolves two owners concurrently self-demoting to exactly one updated and one last_active_owner, leaving one active owner', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(OWNER2_ID, 'owner');

		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly SynchronizedSetRoleStore[] = synchronizeSetRole([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const cmdA: SetInstanceMemberRoleCommand = setRoleCommand({
				actor: { type: 'user', id: OWNER_ID },
				idempotencyKey: 'self-demote-a',
				targetUserId: OWNER_ID,
				role: 'admin'
			});
			const cmdB: SetInstanceMemberRoleCommand = setRoleCommand({
				actor: { type: 'user', id: OWNER2_ID },
				idempotencyKey: 'self-demote-b',
				targetUserId: OWNER2_ID,
				role: 'admin'
			});

			const [first, second]: SetInstanceMemberRoleStoreResult[] = await Promise.all([
				storeA.setInstanceMemberRole(cmdA),
				storeB.setInstanceMemberRole(cmdB)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['last_active_owner', 'updated']);

			const owners: { userId: string }[] = await database()<
				{ userId: string }[]
			>`SELECT user_id AS "userId" FROM instance_member WHERE role = 'owner' AND status = 'active'`;
			expect(owners).toHaveLength(1);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	/**
	 * The status analogue of the demote-each-other test above. Status
	 * self-targeting is always rejected (`cannot_target_self`), so there is
	 * no status equivalent of the self-handoff race: a distinct active-owner
	 * actor always counts as "another active owner" of its target, so
	 * 'last_active_owner' can never be produced by two distinct owners
	 * suspending each other -- only the admin-ceiling and self-target checks
	 * are reachable this way. The loser here is rejected as
	 * 'member_suspended' because the winning suspension strips the loser's
	 * own actor authority before its command reaches the owner-floor check.
	 * The invariant that matters -- never both succeed, exactly one active
	 * owner survives -- still holds.
	 */
	it('resolves two owners concurrently suspending each other to exactly one updated and one member_suspended, leaving one active owner', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(OWNER2_ID, 'owner');

		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly SynchronizedSetStatusStore[] = synchronizeSetStatus([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const cmdA: SetInstanceMemberStatusCommand = setStatusCommand({
				actor: { type: 'user', id: OWNER_ID },
				idempotencyKey: 'suspend-a-targets-b',
				targetUserId: OWNER2_ID
			});
			const cmdB: SetInstanceMemberStatusCommand = setStatusCommand({
				actor: { type: 'user', id: OWNER2_ID },
				idempotencyKey: 'suspend-b-targets-a',
				targetUserId: OWNER_ID
			});

			const [first, second]: SetInstanceMemberStatusStoreResult[] = await Promise.all([
				storeA.setInstanceMemberStatus(cmdA),
				storeB.setInstanceMemberStatus(cmdB)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['member_suspended', 'updated']);

			const activeOwners: { userId: string }[] = await database()<
				{ userId: string }[]
			>`SELECT user_id AS "userId" FROM instance_member WHERE role = 'owner' AND status = 'active'`;
			expect(activeOwners).toHaveLength(1);

			const suspended: { userId: string }[] = await database()<
				{ userId: string }[]
			>`SELECT user_id AS "userId" FROM instance_member WHERE status = 'suspended'`;
			expect(suspended).toHaveLength(1);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('resolves a genuinely concurrent same-actor, same-idempotency-key role change race to one updated and one replayed with a single persisted row', async (): Promise<void> => {
		await insertMember(OWNER_ID, 'owner');
		await insertMember(TARGET_ID, 'member');

		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const [storeA, storeB]: readonly SynchronizedSetRoleStore[] = synchronizeSetRole([
				new PostgresInstanceStore(concurrentSql),
				new PostgresInstanceStore(concurrentSql)
			]);
			const command: SetInstanceMemberRoleCommand = setRoleCommand({
				idempotencyKey: 'race-same-key'
			});

			const [first, second]: SetInstanceMemberRoleStoreResult[] = await Promise.all([
				storeA.setInstanceMemberRole(command),
				storeB.setInstanceMemberRole(command)
			]);

			const outcomes: string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['replayed', 'updated']);

			const updated: Extract<SetInstanceMemberRoleStoreResult, { outcome: 'updated' }> = (
				first.outcome === 'updated' ? first : second
			) as Extract<SetInstanceMemberRoleStoreResult, { outcome: 'updated' }>;
			const replayed: Extract<SetInstanceMemberRoleStoreResult, { outcome: 'replayed' }> = (
				first.outcome === 'replayed' ? first : second
			) as Extract<SetInstanceMemberRoleStoreResult, { outcome: 'replayed' }>;
			expect(replayed.member).toEqual(updated.member);
			expect(replayed.appliedAt).toBe(updated.appliedAt);

			const commandRows: { targetUserId: string }[] = await database()<
				{ targetUserId: string }[]
			>`SELECT target_user_id AS "targetUserId" FROM instance_member_command WHERE actor_id = ${OWNER_ID}`;
			expect(commandRows).toHaveLength(1);

			const memberRoleRows: { role: string }[] = await database()<
				{ role: string }[]
			>`SELECT role FROM instance_member WHERE user_id = ${TARGET_ID}`;
			expect(memberRoleRows).toEqual([{ role: 'admin' }]);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});
});

/**
 * Gates every delegate's `bootstrapInstance` on all callers having arrived,
 * so two stores on two distinct pool connections genuinely race the same
 * empty-instance precondition instead of one finishing before the other starts.
 */
function synchronizeBootstrap(delegates: readonly InstanceStore[]): readonly InstanceStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: InstanceStore): InstanceStore => ({
		getInstanceCallerContext: delegate.getInstanceCallerContext.bind(delegate),
		createInstanceInvitation: delegate.createInstanceInvitation.bind(delegate),
		listInstanceInvitations: delegate.listInstanceInvitations.bind(delegate),
		acceptInstanceInvitation: delegate.acceptInstanceInvitation.bind(delegate),
		revokeInstanceInvitation: delegate.revokeInstanceInvitation.bind(delegate),
		listInstanceMembers: delegate.listInstanceMembers.bind(delegate),
		setInstanceMemberRole: delegate.setInstanceMemberRole.bind(delegate),
		setInstanceMemberStatus: delegate.setInstanceMemberStatus.bind(delegate),
		bootstrapInstance: async (
			command: BootstrapInstanceCommand
		): Promise<BootstrapInstanceStoreResult> => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.bootstrapInstance(command);
		}
	}));
}

interface SynchronizedCreateStore {
	createInstanceInvitation(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult>;
}

function synchronizeCreate(
	delegates: readonly InstanceStore[]
): readonly SynchronizedCreateStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: InstanceStore): SynchronizedCreateStore => ({
		createInstanceInvitation: async (
			command: CreateInstanceInvitationCommand
		): Promise<CreateInstanceInvitationStoreResult> => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.createInstanceInvitation!(command);
		}
	}));
}

interface SynchronizedAcceptStore {
	acceptInstanceInvitation(
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult>;
}

function synchronizeAccept(
	delegates: readonly InstanceStore[]
): readonly SynchronizedAcceptStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: InstanceStore): SynchronizedAcceptStore => ({
		acceptInstanceInvitation: async (
			command: AcceptInstanceInvitationCommand
		): Promise<AcceptInstanceInvitationStoreResult> => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.acceptInstanceInvitation!(command);
		}
	}));
}

interface SynchronizedSetRoleStore {
	setInstanceMemberRole(
		command: SetInstanceMemberRoleCommand
	): Promise<SetInstanceMemberRoleStoreResult>;
}

/**
 * Gates every delegate's `setInstanceMemberRole` on all callers having
 * arrived, so two stores on two distinct pool connections genuinely race
 * the same owner-floor precondition instead of one finishing before the
 * other starts.
 */
function synchronizeSetRole(
	delegates: readonly InstanceStore[]
): readonly SynchronizedSetRoleStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: InstanceStore): SynchronizedSetRoleStore => ({
		setInstanceMemberRole: async (
			command: SetInstanceMemberRoleCommand
		): Promise<SetInstanceMemberRoleStoreResult> => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.setInstanceMemberRole(command);
		}
	}));
}

interface SynchronizedSetStatusStore {
	setInstanceMemberStatus(
		command: SetInstanceMemberStatusCommand
	): Promise<SetInstanceMemberStatusStoreResult>;
}

function synchronizeSetStatus(
	delegates: readonly InstanceStore[]
): readonly SynchronizedSetStatusStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: InstanceStore): SynchronizedSetStatusStore => ({
		setInstanceMemberStatus: async (
			command: SetInstanceMemberStatusCommand
		): Promise<SetInstanceMemberStatusStoreResult> => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.setInstanceMemberStatus(command);
		}
	}));
}
