import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
	BootstrapInstanceCommand,
	BootstrapInstanceStoreResult,
	InstanceStore
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
const IDEMPOTENCY_KEY: string = 'bootstrap-idem-key-1';
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);
const OTHER_REQUEST_FINGERPRINT: string = 'b'.repeat(64);
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';

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
		bootstrapInstance: async (command: BootstrapInstanceCommand) => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.bootstrapInstance(command);
		}
	}));
}
